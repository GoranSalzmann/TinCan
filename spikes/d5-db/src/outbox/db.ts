// Minimal Db port (05 §3.1) on Kysely + better-sqlite3 for the outbox prototype.
import { AsyncLocalStorage } from "node:async_hooks";
import { Kysely, type Generated, type Transaction } from "kysely";
import { ImmediateSqliteDialect } from "../common/kysely.js";
import { openDb, type Sqlite } from "../common/sqlite.js";
import { SCHEMA } from "../fixture/schema.js";

// Hand-written table types: no codegen. Each module owns its slice.
export interface TextChatTables {
  message: {
    id: string; channel_id: string; author_id: string; content: string; reply_to_id: string | null;
    created_at: number; edited_at: number | null; deleted_at: number | null; flags: Generated<number>;
  };
}
export interface CoreTables {
  outbox: { id: string; topic: string; payload: string; request_id: string | null; created_at: number };
}
export interface SearchTables {
  search_doc: { fts_rowid: Generated<number>; message_id: string };
  message_fts: { rowid: number; content: string; channel_id: string; message_id: string };
}
export type DB = TextChatTables & CoreTables & SearchTables;
export type Tx = Transaction<DB>;

export interface Db {
  query: Kysely<DB>;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  sqlite: Sqlite;
  close(): Promise<void>;
}

export function createDb(path: string, opts: { schema?: boolean } = {}): Db {
  const sqlite = openDb(path, { autoVacuumIncremental: true });
  if (opts.schema !== false) sqlite.exec(SCHEMA);
  const k = new Kysely<DB>({ dialect: new ImmediateSqliteDialect({ database: sqlite }) });
  const inTx = new AsyncLocalStorage<{ open: boolean }>();
  // Root handle refuses use inside an open transaction (would deadlock on Kysely's mutex).
  const query = new Proxy(k, {
    get(target, prop) {
      if (inTx.getStore()?.open) throw new Error(`Db: root handle (.${String(prop)}) used inside a transaction; use tx`);
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return {
    query,
    sqlite,
    async transaction(fn) {
      const state = { open: true };
      try { return await inTx.run(state, () => k.transaction().execute(fn)); } finally { state.open = false; }
    },
    close: () => k.destroy(),
  };
}
