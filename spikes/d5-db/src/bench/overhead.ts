// Per-query cost of each access path on better-sqlite3 (100k-message table).
// Every microsecond here is main-thread time.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Kysely } from "kysely";
import { drizzle as drizzleBs3 } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import { eq, desc, sql } from "drizzle-orm";
import { ImmediateSqliteDialect } from "../common/kysely.js";
import { openDb } from "../common/sqlite.js";
import { message } from "../typed/drizzle-schema.js";
import { Mutex } from "../tx/impls.js";
import type { DB } from "../outbox/db.js";
import { SCHEMA } from "../fixture/schema.js";

const path = join(mkdtempSync(join(tmpdir(), "d5ovh-")), "o.db");
const sqlite = openDb(path);
sqlite.exec(SCHEMA);
const seed = sqlite.prepare("INSERT INTO message (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)");
sqlite.transaction(() => { for (let i = 0; i < 100_000; i++) seed.run(`m${String(i).padStart(8, "0")}`, `c${i % 10}`, "u1", "hello world ".repeat(20), i); })();
const ids = Array.from({ length: 1000 }, (_, i) => `m${String(i * 97).padStart(8, "0")}`);

const k = new Kysely<DB>({ dialect: new ImmediateSqliteDialect({ database: sqlite }) });
// Same Kysely, but the database handed to the dialect caches prepared statements by SQL text.
const stmtCache = new Map<string, ReturnType<typeof sqlite.prepare>>();
const cachingDb = { prepare(q: string) { let s = stmtCache.get(q); if (!s) { s = sqlite.prepare(q); stmtCache.set(q, s); } return s; }, close() { sqlite.close(); } };
const kc = new Kysely<DB>({ dialect: new ImmediateSqliteDialect({ database: cachingDb as unknown as typeof sqlite }) });
const d = drizzleBs3({ client: sqlite });
const mutex = new Mutex();
const p = drizzleProxy(async (q, params, method) => {
  await mutex.lock();
  try {
    const stmt = sqlite.prepare(q);
    if (!stmt.reader) { stmt.run(...params); return { rows: [] }; }
    stmt.raw(true);
    return { rows: method === "get" ? ((stmt.get(...params) as unknown[]) ?? []) : (stmt.all(...params) as unknown[]) };
  } finally { mutex.unlock(); }
});

const rawPk = sqlite.prepare("SELECT * FROM message WHERE id = ?");
const rawPage = sqlite.prepare("SELECT * FROM message WHERE channel_id = ? ORDER BY id DESC LIMIT 50");
const rawIns = sqlite.prepare("INSERT INTO message (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)");
const dPk = d.select().from(message).where(eq(message.id, sql.placeholder("id"))).prepare();
const dPage = d.select().from(message).where(eq(message.channelId, sql.placeholder("c"))).orderBy(desc(message.id)).limit(50).prepare();

let n = 0;
const newId = () => `x${n++}`;
type Op = () => unknown | Promise<unknown>;
const cases: [string, Record<string, Op>][] = [
  ["select by primary key", {
    "raw better-sqlite3 (prepared once)": () => rawPk.get(ids[n++ % 1000]),
    "kysely": () => k.selectFrom("message").selectAll().where("id", "=", ids[n++ % 1000]!).executeTakeFirst(),
    "kysely + statement cache": () => kc.selectFrom("message").selectAll().where("id", "=", ids[n++ % 1000]!).executeTakeFirst(),
    "drizzle sync": () => d.select().from(message).where(eq(message.id, ids[n++ % 1000]!)).get(),
    "drizzle sync, .prepare()d": () => dPk.get({ id: ids[n++ % 1000] }),
    "drizzle sqlite-proxy + mutex": () => p.select().from(message).where(eq(message.id, ids[n++ % 1000]!)).get(),
  }],
  ["page of 50 by channel", {
    "raw better-sqlite3 (prepared once)": () => rawPage.all(`c${n++ % 10}`),
    "kysely": () => k.selectFrom("message").selectAll().where("channel_id", "=", `c${n++ % 10}`).orderBy("id", "desc").limit(50).execute(),
    "kysely + statement cache": () => kc.selectFrom("message").selectAll().where("channel_id", "=", `c${n++ % 10}`).orderBy("id", "desc").limit(50).execute(),
    "drizzle sync": () => d.select().from(message).where(eq(message.channelId, `c${n++ % 10}`)).orderBy(desc(message.id)).limit(50).all(),
    "drizzle sync, .prepare()d": () => dPage.all({ c: `c${n++ % 10}` }),
    "drizzle sqlite-proxy + mutex": () => p.select().from(message).where(eq(message.channelId, `c${n++ % 10}`)).orderBy(desc(message.id)).limit(50).all(),
  }],
  ["insert one row (autocommit)", {
    "raw better-sqlite3 (prepared once)": () => rawIns.run(newId(), "c1", "u1", "hi", 1),
    "kysely": () => k.insertInto("message").values({ id: newId(), channel_id: "c1", author_id: "u1", content: "hi", reply_to_id: null, created_at: 1, edited_at: null, deleted_at: null }).execute(),
    "kysely + statement cache": () => kc.insertInto("message").values({ id: newId(), channel_id: "c1", author_id: "u1", content: "hi", reply_to_id: null, created_at: 1, edited_at: null, deleted_at: null }).execute(),
    "drizzle sync": () => d.insert(message).values({ id: newId(), channelId: "c1", authorId: "u1", content: "hi", createdAt: 1 }).run(),
    "drizzle sqlite-proxy + mutex": () => p.insert(message).values({ id: newId(), channelId: "c1", authorId: "u1", content: "hi", createdAt: 1 }),
  }],
];

console.log(`node ${process.version}; µs per call, median of 5 runs x 5,000 sequential awaited calls`);
for (const [label, impls] of cases) {
  console.log(`\n${label}`);
  for (const [name, op] of Object.entries(impls)) {
    for (let i = 0; i < 2000; i++) await op(); // warm up
    const runs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      for (let i = 0; i < 5000; i++) await op();
      runs.push(((performance.now() - t0) / 5000) * 1000);
    }
    runs.sort((a, b) => a - b);
    console.log(`  ${name.padEnd(38)} ${runs[2]!.toFixed(1).padStart(7)} µs`);
  }
}
