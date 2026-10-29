// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadRnnoise, NoiseGateWorkletNode, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import noiseGateWorklet from "@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url";
import rnnoiseWorklet from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasm from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasm from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { captureConstraints, effectiveSettings, type AudioPrefs, type NoiseTier } from "./prefs.js";
import { dbToGain } from "./transmit.js";

/**
 * Microphone → denoiser → gain → output (09 §1). The browser's echo cancellation stays on in the capture
 * constraints (Studio turns it off); our own noise tier replaces the browser's. Everything runs at 48 kHz.
 *
 * Tiers shipped in M3 (D2, 18 §J): RNNoise (B), browser noise suppression (C) and off (D). The DeepFilterNet-class
 * tier A has no self-hostable build yet.
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
  onDowngrade(cb: (from: NoiseTier, to: NoiseTier, reason: string) => void): void;
  stop(): void;
}

let wasm: ArrayBuffer | null = null;

async function loadModel(): Promise<ArrayBuffer> {
  wasm ??= await loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm });
  return wasm;
}

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
  analyser.fftSize = 1024;
  const out = ctx.createMediaStreamDestination();
  const raw = ctx.createMediaStreamDestination();
  source.connect(raw);

  let tier: NoiseTier = settings.noiseTier;
  let denoise: RnnoiseWorkletNode | null = null;
  let gate: NoiseGateWorkletNode | null = null;
  const listeners: ((from: NoiseTier, to: NoiseTier, reason: string) => void)[] = [];
  const downgrade = (to: NoiseTier, reason: string) => {
    const from = tier;
    tier = to;
    for (const l of listeners) l(from, to, reason);
  };

  if (tier === "rnnoise") {
    try {
      const wasmBinary = await loadModel();
      await ctx.audioWorklet.addModule(rnnoiseWorklet);
      denoise = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
    } catch (err) {
      // Blocked WebAssembly (CSP), no AudioWorklet, or a model that failed to load: fall back, do not fail the call.
      tier = "browser";
      await rawTrack.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
      queueMicrotask(() => downgrade("browser", `denoiser failed to load: ${(err as Error).message}`));
    }
  }
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

  const connectChain = (bypass: boolean) => {
    source.disconnect();
    source.connect(raw);
    denoise?.disconnect();
    gate?.disconnect();
    gain.disconnect();
    let node: AudioNode = source;
    if (!bypass && denoise) {
      node.connect(denoise);
      node = denoise;
    }
    if (!bypass && gate) {
      node.connect(gate);
      node = gate;
    }
    node.connect(gain);
    gain.connect(analyser);
    gain.connect(out);
  };
  connectChain(false);

  // Runtime guard (09 §3): sustained high render load downgrades once, never upgrades within a session.
  const capacity = (
    ctx as AudioContext & { renderCapacity?: EventTarget & { start(o: object): void; stop(): void } }
  ).renderCapacity;
  if (capacity && denoise) {
    let high = 0;
    capacity.addEventListener("update", (e) => {
      const peak = (e as Event & { peakLoad?: number }).peakLoad ?? 0;
      high = peak > 0.7 ? high + 1 : 0;
      if (high >= 5 && tier === "rnnoise") {
        denoise?.disconnect();
        denoise = null;
        connectChain(false);
        void rawTrack.applyConstraints({ noiseSuppression: true }).catch(() => undefined);
        downgrade("browser", "the denoiser used too much CPU");
        capacity.stop();
      }
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
    setBypass: (b) => connectChain(b),
    onDowngrade: (cb) => void listeners.push(cb),
    stop() {
      capacity?.stop();
      denoise?.destroy();
      for (const t of stream.getTracks()) t.stop();
      track.stop();
      void ctx.close();
    },
  };
}
