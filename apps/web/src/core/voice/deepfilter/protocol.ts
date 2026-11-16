// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared by the main thread and the DeepFilterNet worklet; nothing here may touch either side's globals. */

export const PROCESSOR_NAME = "tincan-deepfilternet3";

export interface DeepFilterProcessorOptions {
  module: WebAssembly.Module;
  /** `DeepFilterNet3_onnx.tar.gz`, as served. */
  model: ArrayBuffer;
  /** Attenuation cap in dB; 100 or more means no cap (upstream's default). */
  attenLimDb: number;
}

export type FromWorklet =
  { type: "ready"; hop: number; delaySamples: number } | { type: "error"; message: string };

export type ToWorklet = { type: "atten"; db: number } | { type: "destroy" };
