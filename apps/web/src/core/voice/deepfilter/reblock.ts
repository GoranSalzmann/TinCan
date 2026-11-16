// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turns Web Audio's 128-sample render quanta into the model's hops (480 samples for DeepFilterNet3) and back (09 §3.1).
 *
 * The output starts one hop behind the input. A hop is processed only once enough quanta have arrived, so without that
 * head start the output would run dry every few quanta; with it, it never does. The cost is one hop of delay (10 ms).
 */
export class Reblocker {
  readonly hop: number;
  readonly #pending: Float32Array;
  #pendingLen = 0;
  readonly #ring: Float32Array;
  #read = 0;
  #len: number;

  constructor(hop: number, quantum = 128) {
    if (!Number.isInteger(hop) || hop <= 0)
      throw new RangeError(`hop must be a positive integer, got ${hop}`);
    this.hop = hop;
    this.#pending = new Float32Array(hop);
    // At most one hop of head start, one hop just produced and one quantum not yet read.
    this.#ring = new Float32Array(2 * hop + 2 * quantum);
    this.#len = hop;
  }

  /** Samples waiting to be played, including the head start. */
  get buffered(): number {
    return this.#len;
  }

  /**
   * Feeds `input`, runs `run` on every complete hop, and fills `output` (same length as `input`) with the oldest
   * processed samples. `run` gets a hop of input and returns a hop of output; it may reuse its buffers between calls.
   */
  process(input: Float32Array, output: Float32Array, run: (hop: Float32Array) => ArrayLike<number>): void {
    let i = 0;
    while (i < input.length) {
      const n = Math.min(this.hop - this.#pendingLen, input.length - i);
      this.#pending.set(input.subarray(i, i + n), this.#pendingLen);
      this.#pendingLen += n;
      i += n;
      if (this.#pendingLen === this.hop) {
        this.#push(run(this.#pending));
        this.#pendingLen = 0;
      }
    }
    this.#pull(output);
  }

  #push(samples: ArrayLike<number>): void {
    const cap = this.#ring.length;
    if (this.#len + samples.length > cap) throw new Error("reblocker overflow: output is not being read");
    let w = (this.#read + this.#len) % cap;
    for (let k = 0; k < samples.length; k++) {
      this.#ring[w] = samples[k]!;
      w = w + 1 === cap ? 0 : w + 1;
    }
    this.#len += samples.length;
  }

  #pull(output: Float32Array): void {
    const cap = this.#ring.length;
    const n = Math.min(output.length, this.#len);
    for (let k = 0; k < n; k++) {
      output[k] = this.#ring[this.#read]!;
      this.#read = this.#read + 1 === cap ? 0 : this.#read + 1;
    }
    output.fill(0, n);
    this.#len -= n;
  }
}
