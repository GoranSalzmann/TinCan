// SPDX-License-Identifier: AGPL-3.0-or-later
import workletUrl from "./worklet.ts?worker&url";
import {
  PROCESSOR_NAME,
  type DeepFilterProcessorOptions,
  type FromWorklet,
  type ToWorklet,
} from "./protocol.js";
import { useDeepFilterStatus } from "./status.js";

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

/** Byte sizes of the two files, written by the build script; also how the client learns the server has them. */
export interface DeepFilterManifest {
  wasm: number;
  model: number;
}

let manifest: Promise<DeepFilterManifest> | null = null;
let assets: Promise<{ module: WebAssembly.Module; model: ArrayBuffer }> | null = null;
/** Pipelines whose worklet is still loading the model. */
let starting = 0;

async function get(name: string): Promise<Response> {
  const res = await fetch(BASE + name);
  // A single-page-app fallback answers a missing file with the page itself.
  if (!res.ok || res.headers.get("content-type")?.includes("text/html")) {
    throw new Error(
      res.ok || res.status === 404 ? "not installed on this server" : `HTTP ${res.status} for ${name}`,
    );
  }
  return res;
}

/** The server's DeepFilterNet files; rejects with "not installed on this server" when it has none. Cheap to call again. */
export function deepFilterManifest(): Promise<DeepFilterManifest> {
  if (!manifest) {
    manifest = (async () => {
      const m = (await (await get("manifest.json")).json()) as Partial<DeepFilterManifest>;
      if (typeof m.wasm !== "number" || typeof m.model !== "number")
        throw new Error("manifest.json is not valid");
      return { wasm: m.wasm, model: m.model };
    })();
    manifest.catch(() => {
      manifest = null;
    });
  }
  return manifest;
}

/** Reads a response body to the end, reporting each chunk's size. */
async function read(res: Response, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    onBytes(buf.byteLength);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    onBytes(value.byteLength);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/** Downloads and compiles once per page load; `useDeepFilterStatus` follows the download. */
export function loadDeepFilterAssets(): Promise<{ module: WebAssembly.Module; model: ArrayBuffer }> {
  if (!assets) {
    const status = useDeepFilterStatus;
    assets = (async () => {
      const sizes = await deepFilterManifest();
      // Counts bytes after decompression, which is what the manifest gives; a cached copy simply fills up fast.
      status.setState({ phase: "downloading", loaded: 0, total: sizes.wasm + sizes.model });
      const add = (n: number) => status.setState((s) => ({ loaded: Math.min(s.total, s.loaded + n) }));
      const [wasm, model] = await Promise.all([
        get("deepfilternet3.wasm").then((r) => read(r, add)),
        get("deepfilternet3-model.bin").then((r) => read(r, add)),
      ]);
      // Compiling fails here, not in the worklet, when the browser has no WebAssembly SIMD.
      return { module: await WebAssembly.compile(wasm), model };
    })();
    // A failed download is tried again next time rather than remembered for the session.
    assets.then(
      () => status.setState({ phase: starting > 0 ? "starting" : "ready" }),
      () => {
        assets = null;
        status.setState({ phase: "idle", loaded: 0, total: 0 });
      },
    );
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
  starting++;
  const done = (ok: boolean) => {
    starting--;
    const s = useDeepFilterStatus.getState();
    if (s.phase === "downloading") return; // another pipeline's download is still running
    useDeepFilterStatus.setState({ phase: starting > 0 ? "starting" : assets && ok ? "ready" : "idle" });
  };
  let node: AudioWorkletNode;
  try {
    const { module, model } = await loadDeepFilterAssets();
    useDeepFilterStatus.setState({ phase: "starting" });
    await ctx.audioWorklet.addModule(workletUrl);
    const processorOptions: DeepFilterProcessorOptions = { module, model, attenLimDb };
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions,
    });
  } catch (err) {
    done(false);
    throw err;
  }
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
    done(true);
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
    done(false);
    node.onprocessorerror = null;
    send({ type: "destroy" });
    throw err;
  }
}
