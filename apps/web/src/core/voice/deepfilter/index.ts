// SPDX-License-Identifier: AGPL-3.0-or-later
import workletUrl from "./worklet.ts?worker&url";
import {
  PROCESSOR_NAME,
  type DeepFilterProcessorOptions,
  type FromWorklet,
  type ToWorklet,
} from "./protocol.js";

/**
 * DeepFilterNet3 (09 §3, tier A), self-hosted. The module and the model are build outputs of
 * scripts/build-deepfilternet.sh, served next to the client under /denoise/deepfilternet3/ and fetched the first time
 * someone picks this tier (09 §3.1: lazy, never on app start). A server without them makes this throw, and the
 * pipeline falls back to RNNoise.
 */
const BASE = `${import.meta.env.BASE_URL}denoise/deepfilternet3/`;
const START_TIMEOUT_MS = 15_000;

export interface DeepFilter {
  node: AudioWorkletNode;
  /** Added delay: the model's own plus one hop of re-blocking. */
  delayMs: number;
  destroy(): void;
}

let assets: Promise<{ module: WebAssembly.Module; model: ArrayBuffer }> | null = null;

async function fetchAsset(name: string): Promise<ArrayBuffer> {
  const res = await fetch(BASE + name);
  // A single-page-app fallback answers a missing file with the page itself.
  if (!res.ok || res.headers.get("content-type")?.includes("text/html")) {
    throw new Error(
      res.ok || res.status === 404 ? "not installed on this server" : `HTTP ${res.status} for ${name}`,
    );
  }
  return res.arrayBuffer();
}

function loadAssets(): Promise<{ module: WebAssembly.Module; model: ArrayBuffer }> {
  if (!assets) {
    assets = (async () => {
      const [wasm, model] = await Promise.all([
        fetchAsset("deepfilternet3.wasm"),
        fetchAsset("deepfilternet3-model.bin"),
      ]);
      // Compiling fails here, not in the worklet, when the browser has no WebAssembly SIMD.
      return { module: await WebAssembly.compile(wasm), model };
    })();
    // A failed download is tried again next time rather than remembered for the session.
    assets.catch(() => {
      assets = null;
    });
  }
  return assets;
}

/**
 * Starts the processor and waits until the model is loaded. `onFailure` is called at most once if the processor dies
 * later (a trap in the WebAssembly code); the node then passes nothing on, so the caller must take it out.
 */
export async function createDeepFilter(
  ctx: AudioContext,
  onFailure: (reason: string) => void,
  attenLimDb = 100,
): Promise<DeepFilter> {
  if (ctx.sampleRate !== 48000)
    throw new Error(`it needs 48 kHz audio, this device runs at ${ctx.sampleRate} Hz`);
  const { module, model } = await loadAssets();
  await ctx.audioWorklet.addModule(workletUrl);
  const processorOptions: DeepFilterProcessorOptions = { module, model, attenLimDb };
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions,
  });
  const send = (m: ToWorklet) => node.port.postMessage(m);
  try {
    const ready = await new Promise<Extract<FromWorklet, { type: "ready" }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the model took too long to load")), START_TIMEOUT_MS);
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
        clearTimeout(timer);
        if (e.data.type === "ready") resolve(e.data);
        else reject(new Error(e.data.message));
      };
      node.onprocessorerror = () => {
        clearTimeout(timer);
        reject(new Error("the processor did not start"));
      };
    });
    let failed = false;
    node.onprocessorerror = () => {
      if (failed) return;
      failed = true;
      onFailure("DeepFilterNet stopped working");
    };
    return {
      node,
      delayMs: ((ready.delaySamples + ready.hop) / ctx.sampleRate) * 1000,
      destroy() {
        node.onprocessorerror = null;
        node.disconnect();
        send({ type: "destroy" });
      },
    };
  } catch (err) {
    node.onprocessorerror = null;
    send({ type: "destroy" });
    throw err;
  }
}
