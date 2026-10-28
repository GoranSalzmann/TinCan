// Measures how long the event loop is blocked while `fn` runs.
// A 1 ms interval ticker records the gap between ticks; a gap of N ms means
// nothing else (HTTP, gateway heartbeats) could run for N ms.
import { performance } from "node:perf_hooks";

export interface BlockReport {
  wallMs: number;
  maxGapMs: number;
  p99GapMs: number;
  over50: number;
  over100: number;
  over1000: number;
  ticks: number;
}

export async function measureBlocking<T>(fn: () => Promise<T> | T): Promise<{ result: T; report: BlockReport }> {
  const gaps: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 1);
  await new Promise((r) => setTimeout(r, 30));
  gaps.length = 0;
  const t0 = performance.now();
  last = t0;
  const result = await fn();
  const end = performance.now();
  gaps.push(end - last); // a synchronous fn blocks for its whole duration; this catches it
  clearInterval(timer);
  const sorted = [...gaps].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    result,
    report: {
      wallMs: end - t0,
      maxGapMs: sorted[sorted.length - 1] ?? 0,
      p99GapMs: p(0.99),
      over50: gaps.filter((g) => g > 50).length,
      over100: gaps.filter((g) => g > 100).length,
      over1000: gaps.filter((g) => g > 1000).length,
      ticks: gaps.length,
    },
  };
}

export function fmtReport(r: BlockReport): string {
  return `wall ${r.wallMs.toFixed(0)} ms | max block ${r.maxGapMs.toFixed(1)} ms | p99 gap ${r.p99GapMs.toFixed(1)} ms | gaps>50ms ${r.over50} >100ms ${r.over100} >1s ${r.over1000}`;
}
