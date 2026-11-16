// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadRnnoise, NoiseGateWorkletNode, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import noiseGateWorklet from "@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url";
import rnnoiseWorklet from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasm from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasm from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { createDeepFilter } from "./deepfilter/index.js";
import { captureConstraints, effectiveSettings, type AudioPrefs, type NoiseTier } from "./prefs.js";
import { dbToGain } from "./transmit.js";

/**
 * Microphone → denoiser → gain → output (09 §1). The browser's echo cancellation stays on in the capture
 * constraints (Studio turns it off); our own noise tier replaces the browser's. Everything runs at 48 kHz.
 *
 * Tiers (09 §3): DeepFilterNet3 (A, self-hosted build, opt-in), RNNoise (B, default), browser noise suppression (C) and
 * off (D). A tier that cannot load or keep up steps down A → B → C, once each, never back up within a session.
 */
export interface Pipeline {
  /** The processed track to publish. */
  track: MediaStreamTrack;
  /** What actually runs; may be lower than asked for when the guard downgraded it or a worklet failed to load. */
  tier: NoiseTier;
  analyser: AnalyserNode;
  context: AudioContext;
  /** The same capture without our processing, for the mic test's A/B (09 §9). */
  rawStream: MediaStream;
  processedStream: MediaStream;
  setGainDb(db: number): void;
  /** Mic test A/B: bypass the denoiser and gate while recording the processed stream. */
  setBypass(bypass: boolean): void;
  /** Also replays the downgrades that already happened, such as a denoiser that failed to load. */
  onDowngrade(cb: (from: NoiseTier, to: NoiseTier, reason: string) => void): void;
  stop(): void;
}

interface Denoiser {
  node: AudioNode;
  destroy(): void;
}

let wasm: ArrayBuffer | null = null;

async function loadModel(): Promise<ArrayBuffer> {
  wasm ??= await loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm });
  return wasm;
}

async function createRnnoise(ctx: AudioContext): Promise<Denoiser> {
  const wasmBinary = await loadModel();
  await ctx.audioWorklet.addModule(rnnoiseWorklet);
  const node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
  return { node, destroy: () => node.destroy() };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function createPipeline(prefs: AudioPrefs): Promise<Pipeline> {
  const settings = effectiveSettings(prefs);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: captureConstraints(prefs) });
  const rawTrack = stream.getAudioTracks()[0]!;
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = dbToGain(prefs.inputGainDb);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  // One channel end to end. Browsers often hand over a microphone that declares two channels; RNNoise processes channel 0
  // only, so the second would come out silent, and a two-channel track is published as stereo: heard in the left ear only.
  const mono = ctx.createGain();
  mono.channelCount = 1;
  mono.channelCountMode = "explicit";
  const out = ctx.createMediaStreamDestination();
  out.channelCount = 1;
  out.channelCountMode = "explicit";
  const raw = ctx.createMediaStreamDestination();
  source.connect(raw);

  let tier: NoiseTier = settings.noiseTier;
  let denoise: Denoiser | null = null;
  let gate: NoiseGateWorkletNode | null = null;
  let bypassed = false;
  let stopped = false;
  const history: [NoiseTier, NoiseTier, string][] = [];
  const listeners: ((from: NoiseTier, to: NoiseTier, reason: string) => void)[] = [];
  const downgrade = (to: NoiseTier, reason: string) => {
    const from = tier;
    tier = to;
    history.push([from, to, reason]);
    for (const l of listeners) l(from, to, reason);
  };
  const useBrowserSuppression = () =>
    rawTrack.applyConstraints({ noiseSuppression: true }).catch(() => undefined);

  const connectChain = () => {
    source.disconnect();
    source.connect(raw);
    mono.disconnect();
    source.connect(mono);
    denoise?.node.disconnect();
    gate?.disconnect();
    gain.disconnect();
    let node: AudioNode = mono;
    if (!bypassed && denoise) {
      node.connect(denoise.node);
      node = denoise.node;
    }
    if (!bypassed && gate) {
      node.connect(gate);
      node = gate;
    }
    node.connect(gain);
    gain.connect(analyser);
    gain.connect(out);
  };

  /** Starts the best denoiser at or below `want`. Blocked WebAssembly (CSP), no AudioWorklet or a missing model step down. */
  const start = async (want: NoiseTier): Promise<void> => {
    if (want === "deepfilternet") {
      try {
        denoise = await createDeepFilter(ctx, (reason) => void stepDown(reason));
        return;
      } catch (err) {
        downgrade("rnnoise", `DeepFilterNet could not start: ${message(err)}`);
        want = "rnnoise";
      }
    }
    if (want === "rnnoise") {
      try {
        denoise = await createRnnoise(ctx);
      } catch (err) {
        await useBrowserSuppression();
        downgrade("browser", `RNNoise could not start: ${message(err)}`);
      }
    }
  };

  /** Takes the running denoiser out and starts the next lower tier, keeping audio flowing in between. */
  let stepping = false;
  const stepDown = async (reason: string): Promise<void> => {
    if (stepping || stopped || !denoise) return;
    stepping = true;
    const old = denoise;
    denoise = null;
    old.node.disconnect();
    connectChain();
    old.destroy();
    if (tier === "deepfilternet") {
      downgrade("rnnoise", reason);
      await start("rnnoise");
    } else {
      await useBrowserSuppression();
      downgrade("browser", reason);
    }
    // `start` set `denoise` again (TypeScript cannot see the assignment inside the closure).
    if (stopped) (denoise as Denoiser | null)?.destroy();
    else connectChain();
    stepping = false;
  };

  await start(tier);
  if (settings.noiseGate) {
    try {
      await ctx.audioWorklet.addModule(noiseGateWorklet);
      gate = new NoiseGateWorkletNode(ctx, {
        openThreshold: -50,
        closeThreshold: -58,
        holdMs: 200,
        maxChannels: 1,
      });
    } catch {
      gate = null; // a gate is a nicety; the call goes on without it
    }
  }
  connectChain();

  // Runtime guard (09 §3): sustained high render load steps the denoiser down, never up within a session.
  const capacity = (
    ctx as AudioContext & { renderCapacity?: EventTarget & { start(o: object): void; stop(): void } }
  ).renderCapacity;
  if (capacity && denoise) {
    let high = 0;
    capacity.addEventListener("update", (e) => {
      const peak = (e as Event & { peakLoad?: number }).peakLoad ?? 0;
      high = peak > 0.7 ? high + 1 : 0;
      if (high < 5 || stepping || !denoise) return;
      high = 0;
      void stepDown("the denoiser used too much CPU").then(() => {
        if (!denoise) capacity.stop();
      });
    });
    capacity.start({ updateInterval: 1 });
  }

  const track = out.stream.getAudioTracks()[0]!;
  return {
    track,
    get tier() {
      return tier;
    },
    analyser,
    context: ctx,
    rawStream: raw.stream,
    processedStream: out.stream,
    setGainDb: (db) => {
      gain.gain.value = dbToGain(db);
    },
    setBypass: (b) => {
      bypassed = b;
      connectChain();
    },
    onDowngrade: (cb) => {
      listeners.push(cb);
      for (const [from, to, reason] of history) cb(from, to, reason);
    },
    stop() {
      stopped = true;
      capacity?.stop();
      denoise?.destroy();
      denoise = null;
      for (const t of stream.getTracks()) t.stop();
      track.stop();
      void ctx.close();
    },
  };
}
