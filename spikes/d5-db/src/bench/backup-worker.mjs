// Worker thread that snapshots the DB on its own connection.
// workerData: { src, dest, mode: "backup" | "vacuuminto", pagesPerStep }
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const { src, dest, mode, pagesPerStep } = workerData;
const db = new Database(src, { fileMustExist: true });
db.pragma("busy_timeout = 5000");
const t0 = performance.now();
let steps = 0, restarts = 0, last = Infinity;
try {
  if (mode === "vacuuminto") {
    db.exec(`VACUUM INTO '${dest}'`);
  } else {
    await db.backup(dest, {
      progress({ remainingPages }) {
        steps++; if (remainingPages > last) restarts++; last = remainingPages;
        if (performance.now() - t0 > 180_000) throw new Error("cap");
        return pagesPerStep;
      },
    });
  }
  parentPort.postMessage({ ok: true, ms: performance.now() - t0, steps, restarts });
} catch (e) {
  parentPort.postMessage({ ok: false, ms: performance.now() - t0, steps, restarts, error: String(e.message) });
}
