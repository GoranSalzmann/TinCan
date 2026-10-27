# 09. Audio Processing Pipeline

Goal (G5): the best practical voice quality for ordinary users with ordinary
microphones. This doc defines the signal chain, the denoiser strategy, fallbacks,
settings, and how we will measure quality. Transport settings (Opus, RED, DTX)
are in 08 §6; this doc owns everything before the encoder and after the decoder.

Quality claims here are targets to validate in the audio spike (18 §D2), not
guarantees.

## 1. Pipeline overview

```
 Mic ─▶ getUserMedia (AEC on, NS off, AGC per preset)
      ─▶ [Input gain]
      ─▶ Denoiser (AudioWorklet: DeepFilterNet-class | RNNoise | bypass)
      ─▶ [Gate (VAD + hysteresis)]
      ─▶ [Limiter / soft clip guard]
      ─▶ Local meter + loopback tap
      ─▶ MediaStreamDestination ─▶ LiveKit audio track ─▶ Opus encoder (browser)
                                                          │
                                                          ▼  network (SFU)
 Speakers ◀─ <audio> element (setSinkId) ◀─ Opus decoder ◀─┘
          ◀─ per-user gain ◀─ (optional loudness evening)
```

Order rationale:
1. **Echo cancellation first**, inside the browser capture stage, because AEC needs the exact signal being played out and the raw microphone. Any processing before it would corrupt its model. We therefore never replace AEC.
2. **Neural denoising after AEC**, on already echo-cancelled audio.
3. **Gate after denoise**, so the VAD sees clean speech and does not trigger on residual keyboard noise.
4. **Limiter last** to prevent clipping from gain staging.

## 2. Capture settings

```ts
audio: {
  deviceId, channelCount: 1, sampleRate: 48000,
  echoCancellation: true,        // browser AEC3 (keep)
  noiseSuppression: false,       // we run our own
  autoGainControl: preset.agc,   // true for Standard, false for Aggressive/Studio
  latency: 0.01
}
```
- Fallback if the neural path is unavailable: re-acquire with `noiseSuppression: true` (browser built-in).
- Verify the actually applied constraints with `track.getSettings()` and show them under "stats for nerds".
- Voice-isolation constraint on newer Chromium/macOS (`voiceIsolation`) MAY be offered as another option where supported (verify).

## 3. Denoiser strategy

| Tier | Engine | When | Notes |
|---|---|---|---|
| **A** | DeepFilterNet-class neural model, WASM/SIMD in an AudioWorklet | Default on capable machines | Best quality among open-source options. Operates on 48 kHz in ~10 ms hops (verify for the chosen model version). |
| **B** | RNNoise (WASM) | Low-end CPUs, or user choice | Much smaller and cheaper; weaker on non-stationary noise. |
| **C** | Browser built-in noise suppression | Last resort | Zero extra CPU; variable quality. |
| **D** | Off | Studio/music or external hardware processing | Raw audio after AEC. |

Selection logic:
1. First run: benchmark Tier A for ~3 s on a synthetic signal inside the mic test; if processing time per 128-sample worklet quantum stays well under budget (< 30% of real time), pick A; else B.
2. Runtime guard: the worklet reports its processing time and underruns. If the rolling 95th percentile exceeds 70% of real time for 5 s, auto-downgrade A→B→C and show a non-intrusive notice; never auto-upgrade within a session.
3. User override always wins.

Why not Krisp: not usable with self-hosted LiveKit (LiveKit's Krisp filter is a
Cloud feature) and proprietary (conflicts with AGPL distribution goals).
NVIDIA Broadcast / RTX Voice: cannot be embedded; users who own it can select its
virtual microphone and set Tin Can's denoiser to **Off** (documented tip).

### 3.1 Implementation notes
- Model and WASM shipped with the client bundle, lazy-loaded when the user joins voice for the first time (not on app start). Cache in the browser/Electron cache.
- Prefer a single-threaded WASM build with SIMD. Multi-threaded WASM requires `SharedArrayBuffer`, which needs cross-origin isolation headers (COOP/COEP); these affect third-party embeds and are avoided for the web client. Electron MAY enable isolation for the desktop renderer to unlock threads if profiling shows a benefit.
- Worklet buffering: the model hop (e.g. 480 samples @ 48 kHz) is not a multiple of the Web Audio render quantum (128). Use a ring buffer; this adds up to one hop of algorithmic latency (≈10 ms) plus model lookahead (verify; report real total in stats).
- LiveKit's `TrackProcessor` API can host the chain so the processed track replaces the raw track transparently (`localTrack.setProcessor`), keeping mute/unmute and device switching handled by the SDK.
- **Licence check at pin time:** the DeepFilterNet code and model weights must be confirmed compatible with AGPL distribution (permissive licences are; verify the weights' terms explicitly) and recorded in the third-party notices (03 ADR-018, 18 F2).
- Desktop optimisation (later): a native Rust build via a N-API addon or utility process, shaving CPU/latency; only if profiling shows the need.

## 4. Gate / VAD

- Voice activity detection from the denoiser's own VAD output where available (RNNoise exposes one); otherwise a lightweight Silero-class VAD model (small ONNX/WASM).
- Behaviour: open on speech, hold open ≥ 200 ms after last speech (avoids clipped word endings), close with a short fade (~20 ms) to avoid clicks. Hysteresis thresholds adjustable.
- Used for: noise gate (optional, off in "Natural" preset), **voice-activity transmit mode**, speaking indicator, and DTX friendliness.
- Gate attenuates (e.g. −30 dB) rather than hard zero, which sounds more natural.

## 5. Gain staging and limiter

- Input gain slider (−20 … +20 dB) applied before the denoiser (models expect a reasonable level).
- AGC: browser AGC is acceptable in the "Standard" preset for users with wildly varying levels; off for "Aggressive" because AGC pumps noise up between words; off for "Studio".
- Final stage: soft limiter at −1 dBFS to guard against overs after denoise.
- Optional "auto level" (slow loudness normaliser, target ≈ −20 LUFS-ish short-term for speech) as a later enhancement; not v1 unless the spike shows a need.

## 6. Presets

| Preset | Echo cancel | Denoiser | Gate | AGC | Bitrate / mode | For |
|---|---|---|---|---|---|---|
| **Standard** (default) | On | Tier A (or B) | Off | On | speech ~32 kbps, DTX on | Most people |
| **Aggressive** | On | Tier A max strength | On | Off | speech 24–32 kbps | Noisy rooms, mechanical keyboards, fans |
| **Natural** | On | Tier A light strength | Off | Off | speech 40 kbps | Quiet rooms, good mics |
| **Studio / Music** | Off (headphones required) | Off | Off | Off | 64–96 kbps, DTX off, optional stereo | Music, instruments, external DSP |
| **Custom** | each toggle | | | | | Power users |

A strength slider (0–100%) maps to the model's attenuation limit or a wet/dry
mix. The Host can set the default preset and forbid Studio (bandwidth) via config.

## 7. Echo and headphones

- AEC is on except in Studio. The UI recommends headphones for best results and shows a warning icon when AEC is off.
- **Playback path caveat:** Chromium's AEC is most reliable when remote audio is played by the same page via standard media elements. Routing remote audio through Web Audio nodes (for per-user boost above 100%) can degrade echo cancellation in some browsers. Design: per-user volume 0–100% uses the element `volume`; boost above 100% uses Web Audio gain and is flagged "may cause echo without headphones" (risk K-17, validate in spike).
- Screenshare audio from the sharer's machine includes remote voices if the sharer captures *system* audio, causing echo for everyone else. Mitigations: capture a specific app/window audio where the OS supports it; otherwise warn when capturing full system audio in a call; Windows per-application capture preferred; document platform limits (macOS: K-06).

## 8. Playback side

- Output device via `setSinkId` (Chromium/Electron). Default follows the system device and reacts to device-change events.
- Per-user volume (0–100%, optional boost) and per-user mute, persisted locally.
- Optional "loudness evening" for remote speakers (simple compressor) — later.
- Spatial/stereo panning: not v1.
- Jitter buffer and packet loss concealment come from the browser; RED/FEC in 08.

## 9. Mic test & settings UI

Settings → Voice & Audio:
- Input / output device pickers, live input level meter, clipping indicator.
- **Test your mic:** record 5 s, play back (A/B toggle between processing "On" and "Off" so users hear what the denoiser does).
- Live loopback (monitor) with a latency warning and a headphones-only prompt.
- Preset picker + advanced controls (denoiser tier & strength, gate threshold/hold, AGC, input gain).
- Transmit mode: voice activity (with sensitivity) or **push-to-talk** (keybind; in-window on web and desktop; global toggle-mute shortcuts on desktop), plus PTT release delay (default 200 ms) and optional cue sounds.
- Connection test (08 §10).
- Status line: "Denoiser: DeepFilterNet · CPU 4% · latency 22 ms".

## 10. Push-to-talk

- Web: key events while the window is focused only (browser limitation).
- Desktop (v1): hold-to-talk works while a Tin Can window has focus. Globally (while another app has focus) the app offers **toggle mute / toggle deafen / leave** shortcuts via Electron `globalShortcut`, plus `tincan --toggle-mute` CLI commands for Wayland and for binding to a mouse button through the desktop environment (13 §4.2). A native global hold-to-talk hook (key-down and key-up) is deferred to v1.1 (decision in 18 §F); the design notes remain in 13 §4.2.3.
- PTT unmutes by enabling the track; releasing mutes after the release delay.

## 11. Data flow of state & privacy

- Raw audio never leaves the device except as the encoded WebRTC stream; no server-side processing, no cloud ML.
- The denoiser runs fully on-device; no telemetry of audio content.
- Mic test recordings stay in memory and are discarded.

## 12. Measuring quality (so "best" is evidence, not vibes)

Offline evaluation harness (dev tool, optional CI nightly):
- A corpus: clean speech mixed with typical noises (keyboard, mouse clicks, fans, cafe, traffic, dog bark, baby cry) at several SNRs, plus recorded real-world samples from your actual friends' setups.
- Compare Tier A vs B vs browser NS vs none using objective metrics (e.g. DNSMOS / PESQ-style estimates, speech-preservation checks) plus **blind A/B listening**.
- Latency measurement: loopback test through the worklet chain; budget target total added latency ≤ 30 ms.
- CPU profile on a low-end reference laptop; regression threshold in CI for worklet cost.
- Failure checks: no clicks on gate transitions, no "underwater" artefacts at strength 100%, no clipping of word onsets with the gate.

## 13. Risks specific to audio

| Risk | Mitigation |
|---|---|
| Denoiser artefacts on some voices/mics | Strength slider, quick Off switch, A/B test button, collect sample reports |
| CPU spikes on low-end machines | Runtime guard with auto-downgrade, RNNoise tier |
| WASM load/startup delay | Lazy load, cache, show "preparing audio" state once |
| AEC degraded by Web Audio routing | Keep playback on media elements by default; test (K-17) |
| macOS system audio capture limits | Documented limitation; window audio where available |
| Global hold-to-talk not in v1 (no native hook); Wayland has no global shortcuts | Voice activity + global toggle-mute shortcut + CLI commands (13 §4.2) |
| Model licence issues | Verify weights licence before bundling (F2) |

## Open items
- Choose the exact denoiser build/version and confirm its licence (spike D2).
- Decide whether to ship Tier B at all or only A + browser fallback (size vs benefit).
- Auto-level / loudness normalisation: v1 or later?
- Echo from screenshare system audio: acceptable mitigation set (warn only vs auto-exclude where possible).
