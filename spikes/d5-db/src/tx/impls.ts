// Implementations of the Db port's async `transaction(fn)` (05 §3.1) on one
// better-sqlite3 connection. Each exposes the same tiny surface so the
// scenarios in scenarios.ts can run against all of them.
import { AsyncLocalStorage } from "node:async_hooks";
import { Kysely, type Generated } from "kysely";
import { ImmediateSqliteDialect } from "../common/kysely.js";
import { drizzle as drizzleBs3 } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { eq, count } from "drizzle-orm";
import { openDb, type Sqlite } from "../common/sqlite.js";

export interface Impl<H> {
  name: string;
  root: H;
  insertLog(h: H, tag: string): Promise<void>;
  countTag(h: H, tag: string): Promise<number>;
  tags(h: H): Promise<string[]>;
  transaction<T>(fn: (tx: H) => Promise<T>): Promise<T>;
  close(): void;
}

const DDL = "CREATE TABLE log (seq INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL)";

function freshDb(path: string): Sqlite {
  const db = openDb(path);
  db.exec(DDL);
  return db;
}

// ---------------------------------------------------------------- control
// What a hand-rolled port would do without a mutex: BEGIN, await fn, COMMIT.
export function naive(path: string): Impl<Sqlite> {
  const db = freshDb(path);
  return {
    name: "naive BEGIN/await/COMMIT (control, no mutex)",
    root: db,
    async insertLog(h, tag) { h.prepare("INSERT INTO log(tag) VALUES (?)").run(tag); },
    async countTag(h, tag) { return (h.prepare("SELECT count(*) c FROM log WHERE tag = ?").get(tag) as { c: number }).c; },
    async tags(h) { return (h.prepare("SELECT tag FROM log ORDER BY seq").all() as { tag: string }[]).map((r) => r.tag); },
    async transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try { const r = await fn(db); db.exec("COMMIT"); return r; }
      catch (e) { if (db.inTransaction) db.exec("ROLLBACK"); throw e; }
    },
    close() { db.close(); },
  };
}

// ---------------------------------------------------------------- Kysely
interface KDB { log: { seq: Generated<number>; tag: string } }

export function kysely(path: string): Impl<Kysely<KDB>> {
  const sqlite = freshDb(path);
  const k = new Kysely<KDB>({ dialect: new ImmediateSqliteDialect({ database: sqlite }) });
  return {
    name: `kysely (SqliteDialect, begin immediate)`,
    root: k,
    async insertLog(h, tag) { await h.insertInto("log").values({ tag }).execute(); },
    async countTag(h, tag) {
      const r = await h.selectFrom("log").select((eb) => eb.fn.countAll<number>().as("c")).where("tag", "=", tag).executeTakeFirstOrThrow();
      return r.c;
    },
    async tags(h) { return (await h.selectFrom("log").select("tag").orderBy("seq").execute()).map((r) => r.tag); },
    transaction: (fn) => k.transaction().execute(fn),
    close() { sqlite.close(); },
  };
}

// Same, with the root handle wrapped so that using it inside an open
// transaction fails fast instead of deadlocking on Kysely's connection mutex.
export function kyselyGuarded(path: string): Impl<Kysely<KDB>> {
  const base = kysely(path);
  const k = base.root;
  const inTx = new AsyncLocalStorage<{ open: boolean }>();
  const root = new Proxy(k, {
    get(target, prop) {
      if (inTx.getStore()?.open) throw new Error(`Db: used the root handle (.${String(prop)}) inside a transaction; use the tx handle`);
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v; // Kysely uses #private fields
    },
  });
  return {
    ...base,
    name: "kysely + AsyncLocalStorage guard on the root handle",
    root,
    async transaction(fn) {
      const state = { open: true };
      try { return await inTx.run(state, () => k.transaction().execute(fn)); } finally { state.open = false; }
    },
  };
}

// ---------------------------------------------------------------- Drizzle
const log = sqliteTable("log", { seq: integer("seq").primaryKey({ autoIncrement: true }), tag: text("tag").notNull() });

type Bs3Db = ReturnType<typeof drizzleBs3>;
// Stock better-sqlite3 driver, used the way the async port would call it.
export function drizzleStock(path: string): Impl<Bs3Db> {
  const sqlite = freshDb(path);
  const d = drizzleBs3({ client: sqlite });
  return {
    name: "drizzle better-sqlite3 (stock db.transaction with an async callback)",
    root: d,
    async insertLog(h, tag) { await h.insert(log).values({ tag }); },
    async countTag(h, tag) { return (await h.select({ c: count() }).from(log).where(eq(log.tag, tag)))[0]!.c; },
    async tags(h) { return (await h.select({ tag: log.tag }).from(log).orderBy(log.seq)).map((r) => r.tag); },
    // Type-checks: the sync signature infers T = Promise<...>. Nothing warns.
    transaction: async (fn) => d.transaction((tx) => fn(tx as unknown as Bs3Db)),
    close() { sqlite.close(); },
  };
}

// sqlite-proxy driver over better-sqlite3, with an async mutex and
// AsyncLocalStorage marking which async context owns the open transaction.
type ProxyDb = ReturnType<typeof drizzleProxy>;
export function drizzleProxyMutex(path: string): Impl<ProxyDb> {
  const sqlite = freshDb(path);
  const mutex = new Mutex();
  const owner = new AsyncLocalStorage<symbol>();
  let current: symbol | null = null;

  const exec = (q: string, params: unknown[], method: "run" | "all" | "values" | "get") => {
    const stmt = sqlite.prepare(q);
    if (!stmt.reader) { stmt.run(...params); return { rows: [] as unknown[] }; }
    stmt.raw(true);
    if (method === "get") return { rows: (stmt.get(...params) as unknown[] | undefined) ?? [] };
    return { rows: stmt.all(...params) as unknown[] };
  };

  const d = drizzleProxy(async (q, params, method) => {
    const me = owner.getStore();
    if (me !== undefined && me === current) return exec(q, params, method); // inside the owning tx
    await mutex.lock();
    try { return exec(q, params, method); } finally { mutex.unlock(); }
  });

  return {
    name: "drizzle sqlite-proxy + mutex + AsyncLocalStorage owner",
    root: d,
    async insertLog(h, tag) { await h.insert(log).values({ tag }); },
    async countTag(h, tag) { return (await h.select({ c: count() }).from(log).where(eq(log.tag, tag)))[0]!.c; },
    async tags(h) { return (await h.select({ tag: log.tag }).from(log).orderBy(log.seq)).map((r) => r.tag); },
    async transaction(fn) {
      await mutex.lock();
      const token = Symbol("tx");
      current = token;
      try {
        return await owner.run(token, () => d.transaction((tx) => fn(tx as unknown as ProxyDb), { behavior: "immediate" }));
      } finally {
        current = null;
        mutex.unlock();
      }
    },
    close() { sqlite.close(); },
  };
}

export class Mutex {
  #locked = false;
  #waiters: (() => void)[] = [];
  async lock(): Promise<void> {
    if (!this.#locked) { this.#locked = true; return; }
    await new Promise<void>((r) => this.#waiters.push(r));
  }
  unlock(): void {
    const next = this.#waiters.shift();
    if (next) next(); else this.#locked = false;
  }
}

export const IMPLS = { naive, kysely, kyselyGuarded, drizzleStock, drizzleProxyMutex } as const;
