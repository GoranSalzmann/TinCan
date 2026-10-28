// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  CompiledQuery,
  Kysely,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type SqliteDialectConfig,
  type Transaction,
} from "kysely";
import { flatten, plan, runMigrations } from "./migrations.js";
import type { Db, MigrateOptions, ModuleMigrations, PendingMigration } from "./port.js";
import { snapshotInWorker } from "./snapshot-worker.js";

/**
 * SQLite adapter (03 ADR-007, 05 §3.1). One write connection; Kysely's connection mutex serialises
 * every statement on it, and a transaction holds the connection from BEGIN IMMEDIATE to COMMIT.
 */

// Kysely's driver issues a deferred BEGIN. A write transaction that reads first could then fail with
// SQLITE_BUSY when another process (the admin CLI) wrote in between; BEGIN IMMEDIATE takes the lock up front.
class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin immediate"));
  }
}

class ImmediateSqliteDialect extends SqliteDialect {
  readonly #cfg: SqliteDialectConfig;
  constructor(cfg: SqliteDialectConfig) {
    super(cfg);
    this.#cfg = cfg;
  }
  override createDriver() {
    return new ImmediateSqliteDriver(this.#cfg);
  }
}

/** Prepared-statement cache (D5: 41.5 µs per point query uncached, 9.7 µs cached). */
function withStatementCache(raw: Database.Database, max = 256) {
  const cache = new Map<string, Database.Statement>();
  return {
    close: () => {
      cache.clear();
      raw.close();
    },
    prepare(sql: string) {
      let stmt = cache.get(sql);
      if (stmt) {
        cache.delete(sql);
      } else {
        stmt = raw.prepare(sql);
        if (cache.size >= max) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
      cache.set(sql, stmt);
      return stmt;
    },
  };
}

export interface SqliteOptions {
  /** File path, or ":memory:" (tests; cannot be snapshotted). */
  path: string;
}

interface TxState {
  open: boolean;
}

class SqliteTx<T> implements Db<T> {
  readonly dialect = "sqlite" as const;
  constructor(readonly query: Transaction<T>) {}
  transaction<R>(fn: (tx: Db<T>) => Promise<R>): Promise<R> {
    return fn(this);
  }
  as<U>(): Db<U> {
    return this as unknown as Db<U>;
  }
  async health(): Promise<void> {
    await this.query.selectNoFrom((eb) => eb.val(1).as("ok")).execute();
  }
  migrate(): Promise<void> {
    return Promise.reject(new Error("Db: migrate() cannot run inside a transaction"));
  }
  pendingMigrations(): Promise<PendingMigration[]> {
    return Promise.reject(new Error("Db: pendingMigrations() cannot run inside a transaction"));
  }
  snapshot(): Promise<void> {
    return Promise.reject(new Error("Db: snapshot() cannot run inside a transaction"));
  }
  close(): Promise<void> {
    return Promise.reject(new Error("Db: close() cannot run inside a transaction"));
  }
}

class SqliteDb<T = unknown> implements Db<T> {
  readonly dialect = "sqlite" as const;
  readonly query: Kysely<T>;
  readonly #kysely: Kysely<T>;
  readonly #als = new AsyncLocalStorage<TxState>();
  readonly #path: string;
  #closed = false;

  readonly #raw: Database.Database;

  constructor(kysely: Kysely<T>, path: string, raw: Database.Database) {
    this.#kysely = kysely;
    this.#path = path;
    this.#raw = raw;
    // Without this guard, using the root handle inside a transaction deadlocks every later query (D5).
    this.query = new Proxy(kysely, {
      get: (target, prop) => {
        if (this.#als.getStore()?.open) {
          throw new Error(
            `Db: used the root handle (.${String(prop)}) inside a transaction; use the tx handle passed to the callback`,
          );
        }
        const value: unknown = Reflect.get(target, prop, target);
        // Kysely keeps #private fields, so methods must run against the real instance.
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  async transaction<R>(fn: (tx: Db<T>) => Promise<R>): Promise<R> {
    if (this.#als.getStore()?.open) {
      throw new Error(
        "Db: transaction() on the root handle inside a transaction; call it on the tx handle to join",
      );
    }
    const state: TxState = { open: true };
    try {
      return await this.#als.run(state, () =>
        this.#kysely.transaction().execute((trx) => fn(new SqliteTx<T>(trx))),
      );
    } finally {
      state.open = false;
    }
  }

  as<U>(): Db<U> {
    return this as unknown as Db<U>;
  }

  pendingMigrations(modules: ModuleMigrations[]): Promise<PendingMigration[]> {
    return plan(this.#kysely as Kysely<unknown>, modules).then(flatten);
  }

  migrate(modules: ModuleMigrations[], opts?: MigrateOptions): Promise<void> {
    return runMigrations(
      this.#kysely as Kysely<unknown>,
      (fn) => this.transaction((tx) => fn(tx.query as unknown as Transaction<unknown>)),
      modules,
      opts,
    );
  }

  async snapshot(destPath: string): Promise<void> {
    if (this.#path === ":memory:") throw new Error("Db: an in-memory database cannot be snapshotted");
    mkdirSync(dirname(destPath), { recursive: true });
    await snapshotInWorker(this.#path, destPath);
  }

  async health(): Promise<void> {
    await this.#kysely.selectNoFrom((eb) => eb.val(1).as("ok")).execute();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#kysely.destroy();
    // Kysely only closes a database it has opened a connection on; close ours either way.
    if (this.#raw.open) this.#raw.close();
  }
}

/** Opens (creating if needed) the database with the pragmas of 05 §3.1. */
export function openSqlite(opts: SqliteOptions): Db {
  const memory = opts.path === ":memory:";
  if (!memory) mkdirSync(dirname(opts.path), { recursive: true });
  const raw = new Database(opts.path);
  const fresh = raw.pragma("page_count", { simple: true }) === 0;
  // auto_vacuum can only be chosen before the first table exists; changing it later needs a full VACUUM.
  if (fresh) raw.pragma("auto_vacuum = INCREMENTAL");
  if (!memory) raw.pragma("journal_mode = WAL");
  raw.pragma("synchronous = NORMAL");
  raw.pragma("busy_timeout = 5000");
  raw.pragma("foreign_keys = ON");
  // Once, while the database is empty (1 ms); never on the live event loop afterwards (18 T28).
  if (fresh) raw.pragma("optimize = 0x10002");

  const kysely = new Kysely<unknown>({
    dialect: new ImmediateSqliteDialect({ database: withStatementCache(raw) }),
  });
  return new SqliteDb(kysely, opts.path, raw);
}
