// Q3 of D5 (18 T28, K-32): how long is the main thread blocked on the ~4 GB fixture?
// Usage: tsx src/bench/blocking.ts <fixture.db> <section...>
// Sections: fts unindexed backup backupwrites vacuuminto optimize worker copy retention ftsmerge drain reindex
// Destructive sections (retention ftsmerge drain reindex) run on /data/fixture/work.db, made by `copy`.
import { execSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { measureBlocking, fmtReport } from "../common/blocking.js";
import { openDb, fmtBytes } from "../common/sqlite.js";
import { createDb } from "../outbox/db.js";
import { createMessage, messageSource } from "../outbox/textchat.js";
import { drainAll } from "../outbox/outbox.js";
import { searchHandlers, reindex } from "../outbox/search.js";

const [fixture = "/data/fixture/app.db", ...sections] = process.argv.slice(2);
const WORK = "/data/fixture/work.db";
const BACKUP = "/data/fixture/backup.db";
const want = (s: string) => sections.includes(s);
const out = (label: string, s: string) => console.log(`${label.padEnd(58)} ${s}`);
const rmDb = (p: string) => { for (const x of ["", "-wal", "-shm"]) rmSync(p + x, { force: true }); };
const canDrop = (() => { try { execSync("sync; echo 3 > /proc/sys/vm/drop_caches", { stdio: "ignore" }); return true; } catch { return false; } })();
const dropCaches = () => { if (canDrop) execSync("sync; echo 3 > /proc/sys/vm/drop_caches", { stdio: "ignore" }); };

console.log(`node ${process.version}, fixture ${fmtBytes(statSync(fixture).size)}, page cache drop ${canDrop ? "available (cold = dropped)" : "unavailable"}`);
try { console.log(`cgroup memory limit: ${fmtBytes(Number(execSync("cat /sys/fs/cgroup/memory.max").toString().trim()))}`); } catch { /* no limit */ }

const db = openDb(fixture);
const channels = (db.prepare("SELECT channel_id c, count(*) n FROM message GROUP BY channel_id ORDER BY n DESC").all() as { c: string; n: number }[]);
const allChannels = channels.map((c) => c.c);
const quiet = channels[channels.length - 1]!;
console.log(`messages ${(db.prepare("SELECT max(rowid) m FROM message").get() as { m: number }).m.toLocaleString()}, busiest channel ${channels[0]!.n.toLocaleString()} msgs, quietest ${quiet.n.toLocaleString()} msgs\n`);
const inList = (ids: string[]) => ids.map((c) => `'${c}'`).join(",");

async function timeQuery(label: string, sql: string, params: unknown[] = []) {
  const stmt = db.prepare(sql);
  dropCaches();
  const cold = await measureBlocking(() => stmt.all(...params));
  const warm = await measureBlocking(() => stmt.all(...params));
  out(label, `cold ${cold.report.maxGapMs.toFixed(0).padStart(6)} ms | warm ${warm.report.maxGapMs.toFixed(0).padStart(6)} ms | rows ${(cold.result as unknown[]).length}`);
}

if (want("fts")) {
  console.log("## FTS5 queries (main-thread block = statement time; better-sqlite3 cannot interrupt a running statement)");
  const all = inList(allChannels);
  const hitsOf = (t: string) => (db.prepare("SELECT count(*) c FROM message_fts WHERE message_fts MATCH ?").get(t) as { c: number }).c;
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fv USING fts5vocab(main, 'message_fts', 'row')");
  const rare = (db.prepare("SELECT term FROM temp.fv WHERE doc BETWEEN 80 AND 150 AND term GLOB '[a-z]*' LIMIT 1").get() as { term: string }).term;
  const mid = (db.prepare("SELECT term FROM temp.fv WHERE doc BETWEEN 4000 AND 6000 AND term GLOB '[a-z]*' LIMIT 1").get() as { term: string }).term;
  console.log(`  matches: 'the' ${hitsOf("the").toLocaleString()}, 'game' ${hitsOf("game").toLocaleString()}, 'tonight' ${hitsOf("tonight").toLocaleString()}, mid '${mid}' ${hitsOf(mid).toLocaleString()}, rare '${rare}' ${hitsOf(rare).toLocaleString()}`);
  const base = `SELECT message_id, channel_id FROM message_fts WHERE message_fts MATCH ? AND channel_id IN (${all})`;
  await timeQuery(`rare term '${rare}', newest 50`, `${base} ORDER BY rowid DESC LIMIT 50`, [rare]);
  await timeQuery(`rare term '${rare}', ORDER BY rank LIMIT 50`, `${base} ORDER BY rank LIMIT 50`, [rare]);
  await timeQuery(`mid term '${mid}', ORDER BY rank LIMIT 50`, `${base} ORDER BY rank LIMIT 50`, [mid]);
  await timeQuery("common term 'the', newest 50", `${base} ORDER BY rowid DESC LIMIT 50`, ["the"]);
  // Bounded relevance: rank only the newest 1000 matches (rowid range keeps FTS5 from scoring the rest).
  const floorOf = db.prepare("SELECT rowid r FROM message_fts WHERE message_fts MATCH ? ORDER BY rowid DESC LIMIT 1 OFFSET 999");
  const boundedRank = db.prepare(`${base} AND rowid >= ? ORDER BY rank LIMIT 50`);
  for (const term of ["the", "the OR game OR tonight"]) {
    dropCaches();
    const r = await measureBlocking(() => { const f = (floorOf.get(term) as { r: number } | undefined)?.r ?? 0; return boundedRank.all(term, f); });
    const w = await measureBlocking(() => { const f = (floorOf.get(term) as { r: number } | undefined)?.r ?? 0; return boundedRank.all(term, f); });
    out(`'${term}', rank among newest 1000 matches`, `cold ${r.report.maxGapMs.toFixed(0).padStart(6)} ms | warm ${w.report.maxGapMs.toFixed(0).padStart(6)} ms | rows ${(r.result as unknown[]).length}`);
  }
  await timeQuery("prefix 'kalo*', newest 50", `${base} ORDER BY rowid DESC LIMIT 50`, ["kalo*"]);
  await timeQuery("'the' newest 50 in a channel with no messages (worst filter)", `SELECT message_id FROM message_fts WHERE message_fts MATCH ? AND channel_id = ? ORDER BY rowid DESC LIMIT 50`, ["the", "01NOSUCHCHANNEL0000000000"]);
  await timeQuery("common term 'the', newest 50 + snippet()", `SELECT message_id, snippet(message_fts, 0, '[', ']', '…', 12) s FROM message_fts WHERE message_fts MATCH ? AND channel_id IN (${all}) ORDER BY rowid DESC LIMIT 50`, ["the"]);
  await timeQuery("common term 'the', ORDER BY rank (bm25) LIMIT 50", `${base} ORDER BY rank LIMIT 50`, ["the"]);
  await timeQuery("'the OR game OR tonight', ORDER BY rank LIMIT 50", `${base} ORDER BY rank LIMIT 50`, ["the OR game OR tonight"]);
  await timeQuery("phrase \"the game\", newest 50", `${base} ORDER BY rowid DESC LIMIT 50`, ['"the game"']);
  await timeQuery("prefix 'ka*', newest 50", `${base} ORDER BY rowid DESC LIMIT 50`, ["ka*"]);
  await timeQuery("prefix 'ka*', ORDER BY rank LIMIT 50", `${base} ORDER BY rank LIMIT 50`, ["ka*"]);
  await timeQuery(`'the' newest 50, only quietest channel (${quiet.n} msgs)`, `SELECT message_id FROM message_fts WHERE message_fts MATCH ? AND channel_id = ? ORDER BY rowid DESC LIMIT 50`, ["the", quiet.c]);
  await timeQuery("count(*) of all hits for 'the' (\"N results\")", `SELECT count(*) c FROM message_fts WHERE message_fts MATCH ?`, ["the"]);
  await timeQuery("history page: 50 newest in busiest channel (B-tree)", "SELECT id, content FROM message WHERE channel_id = ? ORDER BY id DESC LIMIT 50", [channels[0]!.c]);
  console.log();
}

if (want("unindexed")) {
  console.log("## Index maintenance by message_id (06 §3.9 keys FTS rows by an UNINDEXED message_id)");
  const target = (db.prepare("SELECT message_id m, rowid r FROM message_fts WHERE rowid = 1000000").get() as { m: string; r: number });
  for (const [label, sql, p] of [
    ["lookup FTS row by UNINDEXED message_id", "SELECT rowid FROM message_fts WHERE message_id = ?", target.m],
    ["lookup via search_doc(message_id) -> rowid", "SELECT fts_rowid FROM search_doc WHERE message_id = ?", target.m],
    ["lookup FTS row by rowid", "SELECT message_id FROM message_fts WHERE rowid = ?", target.r],
  ] as const) {
    const stmt = db.prepare(sql);
    dropCaches();
    const r = await measureBlocking(() => stmt.get(p));
    out(label, `${r.report.maxGapMs.toFixed(1)} ms (cold)`);
  }
  console.log();
}

async function backupRun(label: string, src: Database.Database, pagesPerStep: number, writer?: () => void) {
  rmDb(BACKUP);
  let steps = 0, restarts = 0, lastRemaining = Infinity;
  let wTimer: NodeJS.Timeout | undefined;
  if (writer) wTimer = setInterval(writer, 10);
  const t0 = performance.now();
  let capped = false;
  const r = await measureBlocking(() => src.backup(BACKUP, {
    progress({ remainingPages }) {
      steps++; if (remainingPages > lastRemaining) restarts++; lastRemaining = remainingPages;
      if (performance.now() - t0 > 180_000) { capped = true; throw new Error("cap"); }
      return pagesPerStep;
    },
  }).catch((e) => { if (!capped) throw e; }));
  if (wTimer) clearInterval(wTimer);
  out(label, `${fmtReport(r.report)} | steps ${steps}${writer ? ` | restarts ${restarts}` : ""}${capped ? " | GAVE UP after 180 s, never completed" : ""}`);
}

if (want("backup")) {
  console.log("## Incremental .backup() of the live DB (4 KiB pages)");
  for (const pages of [100, 1_000, 10_000, 100_000]) { dropCaches(); await backupRun(`.backup(), ${pages} pages/step (${fmtBytes(pages * 4096)})`, db, pages); }
  console.log();
}

if (want("backupwrites")) {
  console.log("## .backup() while the app writes 100 rows/s (1000 pages/step)");
  db.exec("CREATE TABLE IF NOT EXISTS bench_writes (id INTEGER PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO bench_writes (v) VALUES ('x')");
  await backupRun("source = the writer connection", db, 1000, () => ins.run());
  const reader = openDb(fixture);
  await backupRun("source = a second connection (writer is another)", reader, 1000, () => ins.run());
  reader.close();
  db.exec("DROP TABLE bench_writes");
  console.log();
}

if (want("vacuuminto")) {
  console.log("## VACUUM INTO (comparison only; 05 §3.1 bans it on the live process)");
  rmDb(BACKUP);
  dropCaches();
  const r = await measureBlocking(() => db.exec(`VACUUM INTO '${BACKUP}'`));
  out("VACUUM INTO", fmtReport(r.report));
  console.log();
}

if (want("optimize")) {
  console.log("## Maintenance pragmas on the live DB");
  for (const [label, sqlText] of [
    ["PRAGMA optimize=0x10002 (recommended at open)", "PRAGMA optimize=0x10002"],
    ["PRAGMA optimize (weekly job)", "PRAGMA optimize"],
    ["PRAGMA analysis_limit=1000; ANALYZE", "PRAGMA analysis_limit=1000; ANALYZE"],
    ["PRAGMA incremental_vacuum (no free pages)", "PRAGMA incremental_vacuum"],
  ] as const) {
    const fresh = openDb(fixture);
    dropCaches();
    const r = await measureBlocking(() => fresh.exec(sqlText));
    out(label, fmtReport(r.report));
    fresh.close();
  }
  console.log("  (removing sqlite_stat1 left by these runs so the fixture stays as generated)");
  db.exec("DROP TABLE IF EXISTS sqlite_stat1; DROP TABLE IF EXISTS sqlite_stat4");
  console.log();
}

if (want("worker")) {
  console.log("## Same work on a worker thread with its own read-only connection");
  const w = new Worker(new URL("./search-worker.mjs", import.meta.url), { workerData: { path: fixture } });
  let seq = 0;
  const pending = new Map<number, (v: any) => void>();
  w.on("message", (m) => { pending.get(m.id)?.(m); pending.delete(m.id); });
  const call = (sql: string, params: unknown[], all = true) => new Promise<any>((res) => { const id = seq++; pending.set(id, res); w.postMessage({ id, sql, params, all }); });
  const ids = (db.prepare("SELECT id FROM message WHERE rowid % 3000 = 0").all() as { id: string }[]).map((r) => r.id);
  const pk = db.prepare("SELECT id, content FROM message WHERE id = ?");
  for (const id of ids) { pk.get(id); await call("SELECT id, content FROM message WHERE id = ?", [id], false); } // warm
  let t0 = performance.now();
  for (const id of ids) pk.get(id);
  const mainUs = ((performance.now() - t0) / ids.length) * 1000;
  t0 = performance.now();
  for (const id of ids) await call("SELECT id, content FROM message WHERE id = ?", [id], false);
  const workerUs = ((performance.now() - t0) / ids.length) * 1000;
  out("point lookup by id: main thread vs worker round trip", `${mainUs.toFixed(0)} µs vs ${workerUs.toFixed(0)} µs (${ids.length} lookups)`);

  db.exec("CREATE TABLE IF NOT EXISTS bench_writes (id INTEGER PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO bench_writes (v) VALUES ('x')");
  const lat: number[] = [];
  const wt = setInterval(() => { const a = performance.now(); ins.run(); lat.push(performance.now() - a); }, 10);
  dropCaches();
  const heavy = `SELECT message_id FROM message_fts WHERE message_fts MATCH ? AND channel_id IN (${inList(allChannels)}) ORDER BY rank LIMIT 50`;
  const r = await measureBlocking(() => call(heavy, ["the"]));
  clearInterval(wt);
  lat.sort((a, b) => a - b);
  out("heavy rank query on worker, main writes 100/s", `${fmtReport(r.report)} | main write p99 ${(lat[Math.floor(lat.length * 0.99)] ?? 0).toFixed(1)} ms over ${lat.length} writes`);
  db.exec("DROP TABLE bench_writes");
  await w.terminate();
  console.log();
}

if (want("copy")) {
  rmDb(WORK);
  const t0 = performance.now();
  await db.backup(WORK, { progress: () => 10_000 });
  console.log(`(copied fixture to ${WORK} in ${((performance.now() - t0) / 1000).toFixed(0)} s for destructive sections)\n`);
}

db.close();
const needWork = ["retention", "ftsmerge", "drain", "reindex"].some(want);
if (needWork && !existsSync(WORK)) throw new Error("run the `copy` section first");

if (want("retention")) {
  console.log("## messages.retention: hard-delete the oldest 100k messages in batches, then incremental_vacuum");
  const w = openDb(WORK);
  const oldest = w.prepare("SELECT id FROM message ORDER BY id LIMIT ?");
  const delMsg = w.prepare("DELETE FROM message WHERE id = ?");
  const docOf = w.prepare("SELECT fts_rowid r FROM search_doc WHERE message_id = ?");
  const delFts = w.prepare("DELETE FROM message_fts WHERE rowid = ?");
  const delDoc = w.prepare("DELETE FROM search_doc WHERE fts_rowid = ?");
  for (const batch of [100, 500, 2000]) {
    const delBatch = w.transaction((ids: string[]) => { for (const id of ids) { delMsg.run(id); const d = docOf.get(id) as { r: number } | undefined; if (d) { delFts.run(d.r); delDoc.run(d.r); } } });
    let maxMs = 0, n = 0;
    const t0 = performance.now();
    while (n < 30_000) {
      const ids = (oldest.all(batch) as { id: string }[]).map((r) => r.id);
      const a = performance.now(); delBatch(ids); maxMs = Math.max(maxMs, performance.now() - a);
      n += ids.length;
      await new Promise((r) => setImmediate(r));
    }
    out(`delete 30k messages (+FTS) in batches of ${batch}`, `max block ${maxMs.toFixed(0)} ms per batch, ${((performance.now() - t0) / 1000).toFixed(1)} s total`);
  }
  const free = w.pragma("freelist_count", { simple: true }) as number;
  console.log(`  freelist after deletes: ${free.toLocaleString()} pages (${fmtBytes(free * 4096)})`);
  for (const n of [1_000, 10_000]) {
    const r = await measureBlocking(() => w.pragma(`incremental_vacuum(${n})`));
    out(`PRAGMA incremental_vacuum(${n})`, fmtReport(r.report));
  }
  const r = await measureBlocking(() => w.pragma("incremental_vacuum"));
  out(`PRAGMA incremental_vacuum (all remaining)`, `${fmtReport(r.report)} | freelist now ${w.pragma("freelist_count", { simple: true })}`);
  w.close();
  console.log();
}

if (want("ftsmerge")) {
  console.log("## FTS5 index maintenance");
  const w = openDb(WORK);
  for (const pages of [100, 1000]) {
    const r = await measureBlocking(() => w.exec(`INSERT INTO message_fts(message_fts, rank) VALUES('merge', ${pages})`));
    out(`'merge', ${pages}`, fmtReport(r.report));
  }
  const r = await measureBlocking(() => w.exec("INSERT INTO message_fts(message_fts) VALUES('optimize')"));
  out("'optimize' (full merge)", fmtReport(r.report));
  w.close();
  console.log();
}

if (want("drain")) {
  console.log("## Outbox on the 4 GB DB: 5,000 createMessage use cases, then drain");
  const d = createDb(WORK, { schema: false });
  const r1 = await measureBlocking(async () => { for (let i = 0; i < 5000; i++) await createMessage(d, { channelId: allChannels[i % 30]!, authorId: "u", content: `bench tok${i}x the game tonight` }); });
  out("5,000 createMessage (message + outbox row per tx)", `${fmtReport(r1.report)} | ${(5000 / (r1.report.wallMs / 1000)).toFixed(0)} tx/s`);
  const r2 = await measureBlocking(() => drainAll(d, searchHandlers));
  out(`drain ${r2.result} rows (one tx per row)`, `${fmtReport(r2.report)} | ${(r2.result / (r2.report.wallMs / 1000)).toFixed(0)} rows/s`);
  await d.close();
  console.log();
}

if (want("reindex")) {
  console.log("## `search reindex` on the 4 GB DB (capped at 60 s per phase; rate extrapolated)");
  const d = createDb(WORK, { schema: false });
  const total = (d.sqlite.prepare("SELECT count(*) c FROM message WHERE deleted_at IS NULL").get() as { c: number }).c;
  const startClear = (d.sqlite.prepare("SELECT max(fts_rowid) m FROM search_doc").get() as { m: number }).m;
  const stop = new Error("cap");
  let cleared = 0, t0 = performance.now();
  // phase 1 (clear), capped
  const r1 = await measureBlocking(async () => {
    try { await reindex(d, messageSource, { batch: 500, onStep: (p, n) => { if (p !== "clear" || performance.now() - t0 > 60_000) throw stop; cleared = n; } }); }
    catch (e) { if (e !== stop) throw e; }
  });
  const s1 = (performance.now() - t0) / 1000;
  out(`clear phase: ${cleared.toLocaleString()} of ${startClear.toLocaleString()} rows in ${s1.toFixed(0)} s`, `${(cleared / s1).toFixed(0)} rows/s -> ${(startClear / (cleared / s1) / 60).toFixed(1)} min projected | max block ${r1.report.maxGapMs.toFixed(0)} ms`);
  // phase 2 (re-read + upsert), same loop as reindex(), capped. Most docs still
  // exist here, so this is the slower delete+insert path.
  let indexed = 0, cursor: string | null = null;
  t0 = performance.now();
  const { upsert } = await import("../outbox/search.js");
  const r2 = await measureBlocking(async () => {
    while (performance.now() - t0 < 60_000) {
      indexed += await d.transaction(async (tx) => {
        const docs = await messageSource.page(tx, cursor, 500);
        for (const doc of docs) await upsert(tx, doc);
        cursor = docs[docs.length - 1]!.id;
        return docs.length;
      });
      await new Promise((r) => setImmediate(r));
    }
  });
  const s2 = (performance.now() - t0) / 1000;
  out(`index phase: ${indexed.toLocaleString()} of ${total.toLocaleString()} msgs in ${s2.toFixed(0)} s`, `${(indexed / s2).toFixed(0)} msgs/s -> ${(total / (indexed / s2) / 60).toFixed(1)} min projected | max block ${r2.report.maxGapMs.toFixed(0)} ms`);
  await d.close();
  console.log();
}
