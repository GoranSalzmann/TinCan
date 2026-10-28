// Q2 of D5: the outbox feeds FTS5, catches up after a crash between commit and
// indexing, tolerates redelivery, and `search reindex` repairs a damaged index.
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createDb, type Db } from "./db.js";
import { drainAll, drainOnce } from "./outbox.js";
import { searchHandlers, reindex, query } from "./search.js";
import { createMessage, editMessage, deleteMessage, messageSource } from "./textchat.js";
import { rng } from "../fixture/text.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "d5outbox-"));
const childArgs = (mode: string, path: string, seed: number) => ["--import", "tsx", join(here, "child.ts"), mode, path, String(seed)];

function check(db: Db) {
  const n = (q: string) => (db.sqlite.prepare(q).get() as { c: number }).c;
  const r = {
    live: n("SELECT count(*) c FROM message WHERE deleted_at IS NULL"),
    docs: n("SELECT count(*) c FROM search_doc"),
    fts: n("SELECT count(*) c FROM message_fts"),
    missing: n("SELECT count(*) c FROM message m WHERE m.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM search_doc d WHERE d.message_id = m.id)"),
    stale: n("SELECT count(*) c FROM message m JOIN search_doc d ON d.message_id = m.id JOIN message_fts f ON f.rowid = d.fts_rowid WHERE m.deleted_at IS NULL AND (f.content <> m.content OR f.message_id <> m.id)"),
    orphans: n("SELECT count(*) c FROM search_doc d LEFT JOIN message m ON m.id = d.message_id WHERE m.id IS NULL OR m.deleted_at IS NOT NULL"),
    ftsNoDoc: n("SELECT count(*) c FROM message_fts f WHERE NOT EXISTS (SELECT 1 FROM search_doc d WHERE d.fts_rowid = f.rowid)"),
    outbox: n("SELECT count(*) c FROM outbox"),
  };
  const ok = r.missing === 0 && r.stale === 0 && r.orphans === 0 && r.ftsNoDoc === 0 && r.docs === r.live && r.fts === r.live && r.outbox === 0;
  return { ok, ...r };
}

// Search by each message's unique token: live -> exactly that id; deleted / pre-edit tokens -> nothing.
async function matchCheck(db: Db) {
  const rows = db.sqlite.prepare("SELECT id, content, deleted_at FROM message").all() as { id: string; content: string; deleted_at: number | null }[];
  let bad = 0;
  for (const r of rows) {
    const tok = /tok\d+x/.exec(r.content)![0];
    const hits = await query(db, tok, ["chanA", "chanB", "chanC"]);
    const want = r.deleted_at === null ? 1 : 0;
    if (hits.length !== want || (want && hits[0]!.message_id !== r.id)) bad++;
  }
  return { checked: rows.length, bad };
}

const fmt = (o: object) => JSON.stringify(o).replace(/"/g, "");
const report = (label: string, o: object) => console.log(`  ${label.padEnd(34)} ${fmt(o)}`);

// 1. crash after commit, before indexing
{
  console.log("1. SIGKILL after 600 committed writes (500 create, 50 edit, 50 delete), before any drain");
  const path = join(dir, "s1.db");
  const r = spawnSync(process.execPath, childArgs("commit-then-crash", path, 1), { stdio: "inherit" });
  console.log(`  child exit signal: ${r.signal}`);
  const db = createDb(path);
  report("after restart, before drain:", check(db));
  const t0 = performance.now();
  const delivered = await drainAll(db, searchHandlers);
  report(`drained ${delivered} rows in ${(performance.now() - t0).toFixed(0)} ms:`, check(db));
  report("token search:", await matchCheck(db));
  await db.close();
}

// 2. crash between handler commit and ack (non-atomic consumer) -> redelivery
{
  console.log("2. SIGKILL after a handler committed but before its outbox row was deleted (redelivery)");
  const path = join(dir, "s2.db");
  const r = spawnSync(process.execPath, childArgs("handler-then-crash", path, 2), { stdio: "inherit" });
  console.log(`  child exit signal: ${r.signal}`);
  const db = createDb(path);
  const before = check(db);
  report("after restart, before drain:", before);
  await drainAll(db, searchHandlers);
  report("after drain:", check(db));
  report("token search:", await matchCheck(db));
  await db.close();
}

// 3. random SIGKILLs while writes and drain run concurrently
{
  console.log("3. 8 rounds of SIGKILL at a random moment while writes and drain run concurrently");
  const path = join(dir, "s3.db");
  const rand = rng(3);
  for (let round = 0; round < 8; round++) {
    const child = spawn(process.execPath, childArgs("load", path, 10 + round), { stdio: "inherit" });
    const ms = 300 + Math.floor(rand() * 900);
    await new Promise((res) => { setTimeout(() => child.kill("SIGKILL"), ms); child.on("exit", res); });
    const db = createDb(path);
    const pre = check(db);
    await drainAll(db, searchHandlers);
    const post = check(db);
    console.log(`  round ${round}: killed after ${ms} ms; backlog ${pre.outbox}, unindexed ${pre.missing}, stale ${pre.stale} -> after drain ok=${post.ok} (live ${post.live})`);
    await db.close();
  }
  const db = createDb(path);
  report("final token search:", await matchCheck(db));
  await db.close();
}

// 4. reindex repairs a damaged index while writes continue
{
  console.log("4. damage the index, then `search reindex` while writes and drain keep running");
  const path = join(dir, "s4.db");
  const db = createDb(path);
  const ids: string[] = [];
  for (let i = 0; i < 3000; i++) ids.push(await createMessage(db, { channelId: ["chanA", "chanB", "chanC"][i % 3]!, authorId: "u1", content: `seed tok${i}x hello` }));
  await drainAll(db, searchHandlers);
  report("indexed:", check(db));
  db.sqlite.exec("DELETE FROM message_fts WHERE rowid % 10 = 0"); // lost rows
  db.sqlite.exec("UPDATE message_fts SET content = 'garbage tok999999x' WHERE rowid % 17 = 0"); // corrupted rows
  db.sqlite.exec("INSERT INTO search_doc(message_id) VALUES ('ghost'); INSERT INTO message_fts(rowid, content, channel_id, message_id) VALUES (last_insert_rowid(), 'ghost tok888888x', 'chanA', 'ghost')");
  report("damaged:", check(db));
  let stop = false;
  let n = 3000;
  const rand = rng(4);
  const writer = (async () => {
    while (!stop) {
      const r = rand();
      if (r < 0.5) ids.push(await createMessage(db, { channelId: "chanB", authorId: "u3", content: `during tok${n++}x reindex` }));
      else if (r < 0.8) await editMessage(db, ids[Math.floor(rand() * ids.length)]!, `edited tok${n++}x during reindex`);
      else await deleteMessage(db, ids.splice(Math.floor(rand() * ids.length), 1)[0]!);
      await new Promise((res) => setTimeout(res, 1));
    }
  })();
  const drainer = (async () => { while (!stop) { await drainOnce(db, searchHandlers, { batch: 20 }); await new Promise((res) => setTimeout(res, 2)); } })();
  const t0 = performance.now();
  const res = await reindex(db, messageSource, { batch: 200 });
  const ms = performance.now() - t0;
  stop = true;
  await Promise.all([writer, drainer]);
  await drainAll(db, searchHandlers);
  report(`reindex ${fmt(res)} in ${ms.toFixed(0)} ms:`, check(db));
  report("token search:", await matchCheck(db));
  await db.close();
}
