// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * One persistent worker thread with its own read-only connection (05 §3.1, 18 T28). Search runs here:
 * better-sqlite3 cannot interrupt a statement, so a slow FTS query must not hold the main thread, and
 * the bounded query shapes in 06 §3.9 keep any one query short enough for the worker not to back up.
 * WAL lets this connection read committed rows while the main connection keeps writing.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.sqlite);
const db = new Database(workerData.path, { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 5000");
parentPort.on("message", (m) => {
  try {
    const stmt = db.prepare(m.sql);
    if (!stmt.reader) throw new Error("readOnly() takes a statement that returns rows");
    const rows = stmt.all(...m.params);
    parentPort.postMessage({ id: m.id, rows });
  } catch (err) {
    parentPort.postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
});
`;

const require = createRequire(import.meta.url);

interface Pending {
  resolve(rows: unknown[]): void;
  reject(err: Error): void;
}

export class ReadWorker {
  readonly #path: string;
  #worker: Worker | null = null;
  readonly #pending = new Map<number, Pending>();
  #seq = 0;
  #closed = false;

  constructor(path: string) {
    this.#path = path;
  }

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sqlite: require.resolve("better-sqlite3"), path: this.#path },
    });
    worker.on("message", (m: { id: number; rows?: unknown[]; error?: string }) => {
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.rows ?? []);
    });
    const fail = (err: Error) => {
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
      this.#worker = null; // the next query starts a fresh worker
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (!this.#closed) fail(new Error(`read worker exited with ${code}`));
    });
    // A worker must never keep the process alive on its own.
    worker.unref();
    this.#worker = worker;
    return worker;
  }

  query<R>(sql: string, params: readonly unknown[]): Promise<R[]> {
    if (this.#closed) return Promise.reject(new Error("Db: closed"));
    return new Promise<R[]>((resolve, reject) => {
      const id = ++this.#seq;
      this.#pending.set(id, { resolve: resolve as (rows: unknown[]) => void, reject });
      this.#start().postMessage({ id, sql, params });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const w = this.#worker;
    this.#worker = null;
    for (const p of this.#pending.values()) p.reject(new Error("Db: closed"));
    this.#pending.clear();
    if (w) await w.terminate();
  }
}
