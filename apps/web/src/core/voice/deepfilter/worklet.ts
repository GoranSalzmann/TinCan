// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AudioWorklet processor for DeepFilterNet3 (09 §3, tier A). Bundled on its own by Vite (`?worker&url`) and loaded from
 * this origin, so the CSP needs nothing beyond `'wasm-unsafe-eval'`, which RNNoise already needs.
 *
 * The WebAssembly module (apps/denoise-wasm) imports nothing and exports plain functions; see its src/lib.rs for the
 * memory protocol.
 */
import type { DeepFilterProcessorOptions, FromWorklet, ToWorklet } from "./protocol.js";
import { PROCESSOR_NAME } from "./protocol.js";
import { Reblocker } from "./reblock.js";

interface DfnExports {
  memory: WebAssembly.Memory;
  dfn_alloc(len: number): number;
  dfn_free(ptr: number, len: number): void;
  dfn_create(ptr: number, len: number, attenLimDb: number): number;
  dfn_hop_size(st: number): number;
  dfn_delay_samples(st: number): number;
  dfn_input(st: number): number;
  dfn_output(st: number): number;
  dfn_process(st: number): number;
  dfn_set_atten_lim(st: number, db: number): void;
  dfn_destroy(st: number): void;
}

/** The parts of AudioWorkletGlobalScope used here; the DOM lib does not describe that scope. */
interface WorkletScope {
  AudioWorkletProcessor: new () => { readonly port: MessagePort };
  registerProcessor(name: string, ctor: new (options: AudioWorkletNodeOptions) => unknown): void;
}
const scope = globalThis as unknown as WorkletScope;

class DeepFilterProcessor extends scope.AudioWorkletProcessor {
  #x: DfnExports | null = null;
  #st = 0;
  #reblock: Reblocker | null = null;
  #heap: ArrayBuffer | null = null;
  #in = new Float32Array(0);
  #out = new Float32Array(0);
  #done = false;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.#onMessage(e.data);
    try {
      const o = options.processorOptions as DeepFilterProcessorOptions;
      const x = new WebAssembly.Instance(o.module, {}).exports as unknown as DfnExports;
      const model = new Uint8Array(o.model);
      const ptr = x.dfn_alloc(model.length);
      new Uint8Array(x.memory.buffer, ptr, model.length).set(model);
      const st = x.dfn_create(ptr, model.length, o.attenLimDb);
      x.dfn_free(ptr, model.length);
      if (st === 0) throw new Error("the model file is not a DeepFilterNet model");
      this.#x = x;
      this.#st = st;
      this.#reblock = new Reblocker(x.dfn_hop_size(st));
      this.#post({ type: "ready", hop: this.#reblock.hop, delaySamples: x.dfn_delay_samples(st) });
    } catch (err) {
      this.#post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  #post(m: FromWorklet): void {
    this.port.postMessage(m);
  }

  #onMessage(m: ToWorklet): void {
    if (m.type === "atten" && this.#x && this.#st) this.#x.dfn_set_atten_lim(this.#st, m.db);
    if (m.type === "destroy") {
      if (this.#x && this.#st) this.#x.dfn_destroy(this.#st);
      this.#x = null;
      this.#st = 0;
      this.#done = true;
    }
  }

  /** Views into linear memory; memory growth swaps the buffer, which detaches the old views. */
  #views(): void {
    const x = this.#x!;
    if (this.#heap === x.memory.buffer) return;
    this.#heap = x.memory.buffer;
    const hop = this.#reblock!.hop;
    this.#in = new Float32Array(this.#heap, x.dfn_input(this.#st), hop);
    this.#out = new Float32Array(this.#heap, x.dfn_output(this.#st), hop);
  }

  #run = (hop: Float32Array): Float32Array => {
    this.#views();
    this.#in.set(hop);
    this.#x!.dfn_process(this.#st);
    this.#views();
    return this.#out;
  };

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.#done) return false;
    const out = outputs[0];
    if (!out?.length) return true;
    const input = inputs[0]?.[0];
    if (!input || !this.#x || !this.#reblock) {
      // Not connected yet, or the model failed (the main thread is already falling back): pass the input through.
      for (const ch of out) {
        if (input) ch.set(input);
        else ch.fill(0);
      }
      return true;
    }
    this.#reblock.process(input, out[0]!, this.#run);
    for (let c = 1; c < out.length; c++) out[c]!.set(out[0]!);
    return true;
  }
}

scope.registerProcessor(PROCESSOR_NAME, DeepFilterProcessor);
