// Opens better-sqlite3 the way 05 §3.1 specifies.
import Database from "better-sqlite3";

export type Sqlite = Database.Database;

export function openDb(path: string, opts: { readonly?: boolean; autoVacuumIncremental?: boolean } = {}): Sqlite {
  const db = new Database(path, { readonly: opts.readonly ?? false });
  // auto_vacuum can only be chosen before the first table exists; incremental_vacuum
  // (05 §7) is a no-op on a database created without it.
  if (opts.autoVacuumIncremental) db.pragma("auto_vacuum = INCREMENTAL");
  if (!opts.readonly) db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function fmtBytes(n: number): string {
  if (n > 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  return (n / 1e3).toFixed(1) + " kB";
}
