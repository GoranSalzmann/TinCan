// SPDX-License-Identifier: AGPL-3.0-or-later

export interface JobOptions {
  /** Fraction of the interval added at random to each wait (0–1). Default 0.1. */
  jitter?: number;
  /** Run once right after start instead of waiting a full interval. */
  runOnStart?: boolean;
}

export interface JobStats {
  name: string;
  runs: number;
  failures: number;
  skippedOverlaps: number;
  lastDurationMs: number | null;
  running: boolean;
}

export interface JobScheduler {
  every(name: string, intervalMs: number, fn: () => Promise<void> | void, opts?: JobOptions): void;
}

interface Job {
  name: string;
  intervalMs: number;
  fn: () => Promise<void> | void;
  opts: JobOptions;
  stats: JobStats;
  timer?: NodeJS.Timeout;
}

/** Tiny internal scheduler (05 §7): intervals with jitter, overlap protection and per-job stats. */
export class Scheduler implements JobScheduler {
  readonly #jobs = new Map<string, Job>();
  readonly #log: { error(obj: unknown, msg?: string): void };
  #started = false;
  #stopped = false;

  constructor(log: { error(obj: unknown, msg?: string): void }) {
    this.#log = log;
  }

  every(name: string, intervalMs: number, fn: () => Promise<void> | void, opts: JobOptions = {}): void {
    if (this.#jobs.has(name)) throw new Error(`job '${name}' registered twice`);
    const job: Job = {
      name,
      intervalMs,
      fn,
      opts,
      stats: { name, runs: 0, failures: 0, skippedOverlaps: 0, lastDurationMs: null, running: false },
    };
    this.#jobs.set(name, job);
    if (this.#started) this.#schedule(job, opts.runOnStart ? 0 : undefined);
  }

  start(): void {
    this.#started = true;
    for (const job of this.#jobs.values()) this.#schedule(job, job.opts.runOnStart ? 0 : undefined);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const job of this.#jobs.values()) clearTimeout(job.timer);
    while ([...this.#jobs.values()].some((j) => j.stats.running)) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  stats(): JobStats[] {
    return [...this.#jobs.values()].map((j) => ({ ...j.stats }));
  }

  /** Runs a job now. Used by tests and by admin commands. */
  async runNow(name: string): Promise<void> {
    const job = this.#jobs.get(name);
    if (!job) throw new Error(`unknown job '${name}'`);
    await this.#run(job);
  }

  #schedule(job: Job, delay?: number): void {
    if (this.#stopped) return;
    const wait = delay ?? Math.round(job.intervalMs * (1 + Math.random() * (job.opts.jitter ?? 0.1)));
    job.timer = setTimeout(() => {
      void this.#run(job).finally(() => this.#schedule(job));
    }, wait);
    job.timer.unref();
  }

  async #run(job: Job): Promise<void> {
    if (job.stats.running) {
      job.stats.skippedOverlaps++;
      return;
    }
    job.stats.running = true;
    const started = performance.now();
    try {
      await job.fn();
    } catch (err) {
      job.stats.failures++;
      this.#log.error({ err, job: job.name }, "job failed");
    } finally {
      job.stats.runs++;
      job.stats.lastDurationMs = Math.round(performance.now() - started);
      job.stats.running = false;
    }
  }
}
