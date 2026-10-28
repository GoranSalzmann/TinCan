// Follow-up experiments after the first blocking run (see RESULTS.md):
//   rankfix   bounded relevance written with bm25() instead of the `rank` column
//   chanfts   FTS5 with the channel as an indexed token column, for visibility filters
//   bgsnap    backup / VACUUM INTO on a worker thread while the main thread writes 100 rows/s
// Usage: tsx src/bench/followup.ts <section...>   (chanfts writes to /data/fixture/work.db)
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { measureBlocking, fmtReport } from "../common/blocking.js";
import { openDb } from "../common/sqlite.js";

const sections = process.argv.slice(2);
const FIXTURE = "/data/fixture/app.db";
const WORK = "/data/fixture/work.db";
const BACKUP = "/data/fixture/backup.db";
const out = (label: string, s: string) => console.log(`${label.padEnd(60)} ${s}`);
const dropCaches = () => { try { execSync("sync; echo 3 > /proc/sys/vm/drop_caches", { stdio: "ignore" }); } catch { /* not privileged */ } };
const rmDb = (p: string) => { for (const x of ["", "-wal", "-shm", "-journal"]) rmSync(p + x, { force: true }); };

async function coldWarm(label: string, fn: () => unknown) {
  dropCaches();
  const c = await measureBlocking(fn);
  const w = await measureBlocking(fn);
  out(label, `cold ${c.report.maxGapMs.toFixed(0).padStart(6)} ms | warm ${w.report.maxGapMs.toFixed(0).padStart(6)} ms | rows ${(c.result as unknown[]).length}`);
}

if (sections.includes("rankfix")) {
  console.log("## Bounded relevance: rank only the newest 1000 matches");
  const db = openDb(FIXTURE, { readonly: true });
  const floorOf = db.prepare("SELECT rowid r FROM message_fts WHERE message_fts MATCH ? ORDER BY rowid DESC LIMIT 1 OFFSET 999");
  const viaBm25 = db.prepare("SELECT message_id, bm25(message_fts) s FROM message_fts WHERE message_fts MATCH ? AND rowid >= ? ORDER BY s LIMIT 50");
  const viaSub = db.prepare(`SELECT message_id, s FROM (SELECT message_id, bm25(message_fts) s FROM message_fts WHERE message_fts MATCH ? ORDER BY rowid DESC LIMIT 1000) ORDER BY s LIMIT 50`);
  for (const term of ["the", "the OR game OR tonight", "ka*"]) {
    await coldWarm(`'${term}': floor rowid + ORDER BY bm25()`, () => viaBm25.all(term, (floorOf.get(term) as { r: number } | undefined)?.r ?? 0));
    await coldWarm(`'${term}': subquery newest 1000, then ORDER BY bm25()`, () => viaSub.all(term));
  }
  db.close();
  console.log();
}

if (sections.includes("chanfts")) {
  console.log("## Visibility filter as an indexed FTS column (chan) instead of UNINDEXED channel_id");
  const db = openDb(WORK);
  const has = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'message_fts_chan'").get();
  if (!has) {
    db.exec("CREATE VIRTUAL TABLE message_fts_chan USING fts5(content, chan, message_id UNINDEXED)");
    const t0 = performance.now();
    db.exec("INSERT INTO message_fts_chan(rowid, content, chan, message_id) SELECT rowid, content, 'c' || channel_id, message_id FROM message_fts");
    out("built message_fts_chan from message_fts", `${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
  const quiet = (db.prepare("SELECT channel_id c, count(*) n FROM message GROUP BY channel_id ORDER BY n LIMIT 1").get() as { c: string; n: number });
  const q = db.prepare("SELECT message_id FROM message_fts_chan WHERE message_fts_chan MATCH ? ORDER BY rowid DESC LIMIT 50");
  const chanTok = (c: string) => `chan:c${c.toLowerCase()}`;
  await coldWarm(`'the' in quietest channel (${quiet.n} msgs) via chan column`, () => q.all(`the AND ${chanTok(quiet.c)}`));
  await coldWarm("'the' in a channel with no messages via chan column", () => q.all(`the AND ${chanTok("01NOSUCHCHANNEL0000000000")}`));
  const five = (db.prepare("SELECT DISTINCT channel_id c FROM message LIMIT 5").all() as { c: string }[]).map((r) => chanTok(r.c));
  await coldWarm("'the' in 5 visible channels via chan column (OR)", () => q.all(`the AND (${five.join(" OR ")})`));
  console.log();
  db.close();
}

if (sections.includes("ftsdelete")) {
  console.log("## Why the reindex clear phase crawled: FTS5 delete by rowid range vs by single rowid");
  const db = openDb(WORK);
  const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM message_fts WHERE rowid > ? AND rowid <= ?").all(1, 2) as { detail: string }[];
  console.log(`  plan for range delete: ${plan.map((p) => p.detail).join(" / ")}`);
  const ids = (db.prepare("SELECT fts_rowid r FROM search_doc WHERE fts_rowid > 2000000 ORDER BY fts_rowid LIMIT 2000").all() as { r: number }[]).map((x) => x.r);
  const one = db.prepare("DELETE FROM message_fts WHERE rowid = ?");
  const doc = db.prepare("DELETE FROM search_doc WHERE fts_rowid = ?");
  for (const size of [100, 500]) {
    const batch = ids.splice(0, size);
    dropCaches();
    const r = await measureBlocking(() => db.transaction(() => { for (const id of batch) { one.run(id); doc.run(id); } })());
    out(`point deletes, batch of ${size} (driven by search_doc)`, `${r.report.maxGapMs.toFixed(0)} ms -> ${(size / (r.report.maxGapMs / 1000)).toFixed(0)} rows/s`);
  }
  const lo = ids[0]!, hi = lo + 100;
  dropCaches();
  const r = await measureBlocking(() => db.prepare("DELETE FROM message_fts WHERE rowid > ? AND rowid <= ?").run(lo, hi));
  out("range delete, 100 rowids (rowid > ? AND rowid <= ?)", `${r.report.maxGapMs.toFixed(0)} ms`);
  db.close();
  console.log();
}

if (sections.includes("analyze")) {
  console.log("## Where ANALYZE time goes (cold, analysis_limit=1000, fresh copy of stats each time)");
  const db = openDb(WORK);
  db.pragma("analysis_limit = 1000");
  for (const t of ["message", "search_doc", "outbox", "message_fts_content", "message_fts_data", "message_fts_docsize", "message_fts_idx"]) {
    db.exec("DROP TABLE IF EXISTS sqlite_stat1");
    dropCaches();
    const r = await measureBlocking(() => db.exec(`ANALYZE ${t}`));
    out(`ANALYZE ${t}`, `${r.report.maxGapMs.toFixed(0)} ms`);
  }
  db.exec("DROP TABLE IF EXISTS sqlite_stat1");
  db.exec("CREATE TABLE IF NOT EXISTS tiny (x)");
  const empty = openDb("/tmp/empty.db");
  empty.exec("CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, channel_id TEXT)");
  const e = await measureBlocking(() => empty.exec("PRAGMA optimize=0x10002"));
  out("PRAGMA optimize=0x10002 on an empty new DB", `${e.report.maxGapMs.toFixed(1)} ms`);
  empty.close();
  db.close();
  console.log();
}

if (sections.includes("bgsnap")) {
  console.log("## Snapshot on a worker thread (own connection) while the main thread writes 100 rows/s");
  const db = openDb(FIXTURE);
  db.exec("CREATE TABLE IF NOT EXISTS bench_writes (id INTEGER PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO bench_writes (v) VALUES ('x')");
  for (const [mode, pages] of [["backup", 1000], ["vacuuminto", 0]] as const) {
    rmDb(BACKUP);
    dropCaches();
    const lat: number[] = [];
    const timer = setInterval(() => { const a = performance.now(); ins.run(); lat.push(performance.now() - a); }, 10);
    const r = await measureBlocking(() => new Promise<any>((res) => {
      const w = new Worker(new URL("./backup-worker.mjs", import.meta.url), { workerData: { src: FIXTURE, dest: BACKUP, mode, pagesPerStep: pages } });
      w.once("message", (m) => { void w.terminate(); res(m); });
    }));
    clearInterval(timer);
    lat.sort((a, b) => a - b);
    const m = r.result;
    out(`${mode === "backup" ? ".backup() 1000 pages/step" : "VACUUM INTO"} on worker`,
      `${m.ok ? "completed" : "FAILED " + m.error} in ${(m.ms / 1000).toFixed(1)} s${mode === "backup" ? `, restarts ${m.restarts}` : ""} | main: ${fmtReport(r.report)} | write p99 ${(lat[Math.floor(lat.length * 0.99)] ?? 0).toFixed(1)} ms, max ${(lat[lat.length - 1] ?? 0).toFixed(1)} ms`);
  }
  db.exec("DROP TABLE bench_writes");
  db.close();
  console.log();
}
