// Generates the ~4 GB fixture: messages + FTS5 index, one year of a 100-user,
// 30-channel community. Usage: tsx src/fixture/generate.ts [path] [targetGB]
import { existsSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { monotonicFactory } from "ulidx";
import { openDb, fmtBytes } from "../common/sqlite.js";
import { SCHEMA } from "./schema.js";
import { makeTextGen, rng } from "./text.js";

const path = process.argv[2] ?? "/data/fixture/app.db";
const targetBytes = Number(process.argv[3] ?? "4") * 1e9;
const fresh = !existsSync(path);
const db = openDb(path, { autoVacuumIncremental: true });
db.exec(SCHEMA);
console.log(`auto_vacuum=${db.pragma("auto_vacuum", { simple: true })} (2 = incremental) fresh=${fresh}`);
db.pragma("synchronous = OFF"); // bulk load only
db.pragma("cache_size = -262144");

const rand = rng(7);
const ulid = monotonicFactory(() => rand());
const text = makeTextGen(11);
const channels = Array.from({ length: 30 }, (_, i) => ulid(1_700_000_000_000 + i));
const authors = Array.from({ length: 100 }, (_, i) => ulid(1_700_000_000_000 + 100 + i));
// a few busy channels, a long tail of quiet ones
const chanPick = () => channels[Math.min(29, Math.floor(-Math.log(rand() || 1e-9) * 6))]!;

const insMsg = db.prepare("INSERT INTO message (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)");
const insDoc = db.prepare("INSERT INTO search_doc (message_id) VALUES (?)");
const insFts = db.prepare("INSERT INTO message_fts (rowid, content, channel_id, message_id) VALUES (?, ?, ?, ?)");

const existing = (db.prepare("SELECT count(*) c FROM message").get() as { c: number }).c;
let ts = 1_704_067_200_000 + existing * 9_000; // 2024-01-01 + ~9 s per message
const BATCH = 20_000;
const batch = db.transaction((n: number) => {
  for (let i = 0; i < n; i++) {
    ts += 1 + Math.floor(rand() * 17_000);
    const id = ulid(ts);
    const content = text();
    const channel = chanPick();
    insMsg.run(id, channel, authors[Math.floor(rand() * authors.length)], content, ts);
    const docRowid = insDoc.run(id).lastInsertRowid;
    insFts.run(docRowid, content, channel, id);
  }
});

const size = () => (db.pragma("page_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number);
const t0 = performance.now();
let total = existing;
while (size() < targetBytes) {
  batch(BATCH);
  total += BATCH;
  if (total % 200_000 === 0) {
    const s = (performance.now() - t0) / 1000;
    console.log(`${total.toLocaleString()} messages, ${fmtBytes(size())}, ${s.toFixed(0)} s, ${((total - existing) / s).toFixed(0)} msg/s`);
  }
}
db.pragma("synchronous = NORMAL");
db.pragma("wal_checkpoint(TRUNCATE)");
const avgLen = (db.prepare("SELECT avg(length(content)) a FROM message").get() as { a: number }).a;
let tables: { name: string; bytes: number }[] = [];
try { tables = db.prepare("SELECT name, sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12").all() as typeof tables; } catch (e) { console.log("dbstat unavailable:", (e as Error).message); }
console.log(`done: ${total.toLocaleString()} messages, avg content ${avgLen.toFixed(0)} chars, file ${fmtBytes(statSync(path).size)}, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
for (const t of tables) console.log(`  ${t.name.padEnd(28)} ${fmtBytes(t.bytes)}`);
db.close();
