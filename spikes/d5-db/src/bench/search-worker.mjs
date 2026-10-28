// Worker thread holding its own read-only connection (WAL allows it to read
// while the main thread's connection writes). Messages: {id, sql, params, all}.
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const db = new Database(workerData.path, { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 5000");
const cache = new Map();
parentPort.on("message", ({ id, sql, params, all }) => {
  try {
    let stmt = cache.get(sql);
    if (!stmt) { stmt = db.prepare(sql); cache.set(sql, stmt); }
    const rows = all ? stmt.all(...params) : stmt.get(...params);
    parentPort.postMessage({ id, rows });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e.message) });
  }
});
