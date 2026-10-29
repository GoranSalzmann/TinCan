// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Kysely } from "kysely";

/** A forward-only migration owned by one module (06 §8). Types of the touched tables are the module's own. */
export interface Migration {
  /** Integer, strictly increasing within a module. */
  version: number;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- migrations name tables that are not in any typed schema
  up(db: Kysely<any>): Promise<void>;
}

export interface ModuleMigrations {
  module: string;
  migrations: Migration[];
  /** Tables the module owns; lets tests prove a disabled module left nothing behind. */
  tables?: string[];
}

export interface PendingMigration {
  module: string;
  version: number;
  name: string;
}

export interface MigrateOptions {
  /** Called once, before the first pending migration is applied, with everything about to run. */
  beforeApply?: (pending: PendingMigration[]) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Database port (05 §3.1). `T` is the table map the caller may name: modules receive a handle
 * narrowed to their own tables with `db.as<OwnTables>()`.
 */
export interface Db<T = unknown> {
  /** Typed query builder. Throws when touched inside an open transaction of the same async context. */
  readonly query: Kysely<T>;
  readonly dialect: "sqlite" | "postgres";
  /**
   * Runs `fn` in a transaction (BEGIN IMMEDIATE on SQLite). Inside `fn` use only `tx`; do no non-DB
   * awaits. Calling `transaction` on `tx` joins the open transaction.
   */
  transaction<R>(fn: (tx: Db<T>) => Promise<R>): Promise<R>;
  /** Same database, narrowed to the tables of one module. A type-level cast only. */
  as<U>(): Db<U>;
  migrate(modules: ModuleMigrations[], opts?: MigrateOptions): Promise<void>;
  /** Which migrations would run, in order, without applying any. */
  pendingMigrations(modules: ModuleMigrations[]): Promise<PendingMigration[]>;
  /** Consistent copy of the database at `destPath`, taken on a worker thread (05 §3.1, 06 §7). */
  snapshot(destPath: string): Promise<void>;
  /**
   * Runs one read-only statement on the DB worker thread's own connection (05 §3.1). For search and
   * other queries that must not block the event loop. Parameters are bound, never interpolated.
   * Not available for in-memory databases.
   */
  readOnly<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  /** Resolves if the database answers a trivial query. */
  health(): Promise<void>;
  close(): Promise<void>;
}
