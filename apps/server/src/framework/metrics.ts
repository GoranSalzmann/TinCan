// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A small Prometheus-format registry (14 §8). Counters, gauges and histograms with labels, plus "collectors": functions
 * that run at scrape time and copy numbers other parts of the server already keep (job stats, voice counters, the
 * outbox backlog) into gauges, so those parts never need to know about metrics. No dependency, no global state.
 */

type Labels = Record<string, string>;

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const key = (names: readonly string[], labels: Labels | undefined) =>
  names.map((n) => `${n}="${esc(labels?.[n] ?? "")}"`).join(",");
const fmt = (v: number) => (Number.isFinite(v) ? String(v) : v > 0 ? "+Inf" : v < 0 ? "-Inf" : "NaN");

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    readonly type: "counter" | "gauge" | "histogram",
  ) {}
  abstract lines(): string[];
  render(): string {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`, ...this.lines()].join(
      "\n",
    );
  }
  protected series(k: string, suffix = "", extra = ""): string {
    const inner = [k, extra].filter(Boolean).join(",");
    return `${this.name}${suffix}${inner ? `{${inner}}` : ""}`;
  }
}

export class Counter extends Metric {
  readonly #v = new Map<string, number>();
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, labelNames, "counter");
  }
  inc(labels?: Labels, n = 1): void {
    const k = key(this.labelNames, labels);
    this.#v.set(k, (this.#v.get(k) ?? 0) + n);
  }
  /** For totals another component keeps (webhooks received, repairs): copy the cumulative value at scrape time. */
  setTotal(labels: Labels | undefined, total: number): void {
    this.#v.set(key(this.labelNames, labels), total);
  }
  lines(): string[] {
    if (this.#v.size === 0 && this.labelNames.length === 0) return [`${this.name} 0`];
    return [...this.#v].map(([k, v]) => `${this.series(k)} ${fmt(v)}`);
  }
}

export class Gauge extends Metric {
  readonly #v = new Map<string, number>();
  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    super(name, help, labelNames, "gauge");
  }
  set(value: number, labels?: Labels): void {
    this.#v.set(key(this.labelNames, labels), value);
  }
  /** Forget every series, so a label value that disappeared (a room that closed) stops being reported. */
  reset(): void {
    this.#v.clear();
  }
  lines(): string[] {
    return [...this.#v].map(([k, v]) => `${this.series(k)} ${fmt(v)}`);
  }
}

export class Histogram extends Metric {
  readonly #buckets: number[];
  readonly #v = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, labelNames: readonly string[], buckets: readonly number[]) {
    super(name, help, labelNames, "histogram");
    this.#buckets = [...buckets].sort((a, b) => a - b);
  }
  observe(value: number, labels?: Labels): void {
    const k = key(this.labelNames, labels);
    let s = this.#v.get(k);
    if (!s) this.#v.set(k, (s = { counts: this.#buckets.map(() => 0), sum: 0, count: 0 }));
    this.#buckets.forEach((b, i) => {
      if (value <= b) s.counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const [k, s] of this.#v) {
      this.#buckets.forEach((b, i) => out.push(`${this.series(k, "_bucket", `le="${b}"`)} ${s.counts[i]}`));
      out.push(`${this.series(k, "_bucket", 'le="+Inf"')} ${s.count}`);
      out.push(`${this.series(k, "_sum")} ${fmt(s.sum)}`);
      out.push(`${this.series(k, "_count")} ${s.count}`);
    }
    return out;
  }
}

export type Collector = () => void | Promise<void>;

export class MetricsRegistry {
  readonly #metrics = new Map<string, Metric>();
  readonly #collectors: Collector[] = [];
  /** Collectors that threw on the last scrape; reported as a counter so a broken one is visible. */
  readonly collectorFailures = new Counter(
    "tincan_metrics_collector_failures_total",
    "Collectors that failed at scrape time",
  );

  constructor() {
    this.#metrics.set(this.collectorFailures.name, this.collectorFailures);
  }

  #add<T extends Metric>(m: T): T {
    if (this.#metrics.has(m.name)) throw new Error(`metric '${m.name}' registered twice`);
    this.#metrics.set(m.name, m);
    return m;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.#add(new Counter(name, help, labelNames));
  }
  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.#add(new Gauge(name, help, labelNames));
  }
  histogram(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
  ): Histogram {
    return this.#add(new Histogram(name, help, labelNames, buckets));
  }
  collect(fn: Collector): void {
    this.#collectors.push(fn);
  }

  async render(): Promise<string> {
    for (const c of this.#collectors) {
      try {
        await c();
      } catch {
        this.collectorFailures.inc();
      }
    }
    return [...this.#metrics.values()].map((m) => m.render()).join("\n") + "\n";
  }
}

export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
