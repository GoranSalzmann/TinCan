// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { Reblocker } from "./reblock.js";

/** Feeds `quanta` render quanta of a ramp 1, 2, 3, … and returns everything that came out. */
function drive(hop: number, quanta: number, run: (h: Float32Array) => ArrayLike<number>, quantum = 128) {
  const r = new Reblocker(hop, quantum);
  const out: number[] = [];
  let n = 1;
  for (let q = 0; q < quanta; q++) {
    const input = Float32Array.from({ length: quantum }, () => n++);
    const output = new Float32Array(quantum);
    r.process(input, output, run);
    out.push(...output);
  }
  return { r, out };
}

describe("Reblocker (09 §3.1)", () => {
  it("hands the model whole 480-sample hops, in order", () => {
    const seen: number[][] = [];
    drive(480, 15, (h) => {
      seen.push([...h]);
      return h;
    });
    expect(seen.map((h) => h.length)).toEqual([480, 480, 480, 480]); // 15 × 128 = 1920 = 4 hops
    expect(seen.flat()).toEqual(Array.from({ length: 1920 }, (_, i) => i + 1));
  });

  it("delays by exactly one hop and never runs dry after that", () => {
    const { out } = drive(480, 200, (h) => h);
    expect(out.slice(0, 480).every((v) => v === 0)).toBe(true);
    expect(out.slice(480)).toEqual(Array.from({ length: 200 * 128 - 480 }, (_, i) => i + 1));
  });

  it("passes on what the model returns, not the input", () => {
    const { out } = drive(480, 20, (h) => h.map((v) => -v));
    expect(out[480]).toBe(-1);
    expect(out[20 * 128 - 1]).toBe(-(20 * 128 - 480));
  });

  it("works for a hop shorter than a quantum and for odd quantum sizes", () => {
    for (const [hop, quantum] of [
      [64, 128],
      [100, 128],
      [480, 256],
      [441, 128],
    ] as const) {
      const { out, r } = drive(hop, 50, (h) => h, quantum);
      expect(out.slice(hop, hop + 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      // hop − (samples in mod hop): never empty, never more than the head start.
      expect(r.buffered).toBeGreaterThan(0);
      expect(r.buffered).toBeLessThanOrEqual(hop);
      expect(out.at(-1)).toBe(50 * quantum - hop);
    }
  });

  it("rejects a hop that is not a positive integer", () => {
    expect(() => new Reblocker(0)).toThrow(RangeError);
    expect(() => new Reblocker(12.5)).toThrow(RangeError);
  });
});
