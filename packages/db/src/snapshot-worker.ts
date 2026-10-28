// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * `VACUUM INTO` snapshot on a worker thread with its own read-only connection (05 §3.1, 06 §7).
 * D5 (18 §D): 40 s for 4 GB with main-thread write p99 of 4.1 ms. better-sqlite3's incremental
 * `.backup()` stalled the main thread for up to 2.8 s and never finished under writes, so it is not used.
 * SQLite does not fsync VACUUM INTO output: write under a temporary name, fsync, rename.
 *
 * The worker is an inline CommonJS script so it runs the same under tsx, vitest and compiled output.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const Database = require(workerData.sqlite);
try {
  const db = new Database(workerData.src, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  try { fs.rmSync(workerData.tmp, { force: true }); } catch {}
  db.prepare("VACUUM INTO ?").run(workerData.tmp);
  db.close();
  const fd = fs.openSync(workerData.tmp, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(workerData.tmp, workerData.dest);
  parentPort.postMessage({ ok: true });
} catch (err) {
  try { fs.rmSync(workerData.tmp, { force: true }); } catch {}
  parentPort.postMessage({ ok: false, message: String(err && err.message || err) });
}
`;

const require = createRequire(import.meta.url);

export function snapshotInWorker(srcPath: string, destPath: string): Promise<void> {
  const tmp = `${destPath}.tmp-${process.pid}`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sqlite: require.resolve("better-sqlite3"), src: srcPath, tmp, dest: destPath },
    });
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    worker.once("message", (m: { ok: boolean; message?: string }) =>
      done(m.ok ? undefined : new Error(`snapshot failed: ${m.message ?? "unknown error"}`)),
    );
    worker.once("error", (e: Error) => done(e));
    worker.once("exit", (code) =>
      done(code === 0 ? undefined : new Error(`snapshot worker exited with ${code}`)),
    );
  });
}
