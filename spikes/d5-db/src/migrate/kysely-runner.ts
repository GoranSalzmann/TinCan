// Per-module, forward-only migrations (06 §8) on Kysely: plain TS objects, no
// codegen and no CLI. Tracked in _migrations(module, version, applied_at).
import { sql, type Kysely } from "kysely";
import type { Db } from "../outbox/db.js";

export interface Migration { version: number; name: string; up(db: Kysely<any>): Promise<void> }
export interface ModuleMigrations { module: string; migrations: Migration[] }

export async function migrate(db: Db, modules: ModuleMigrations[], log = console.log) {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    module TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL,
    PRIMARY KEY (module, version))`.execute(db.query);
  // Downgrade protection first, for every module, before anything is applied.
  const plan: { module: string; pending: Migration[] }[] = [];
  for (const m of modules) {
    const row = await sql<{ v: number | null }>`SELECT max(version) v FROM _migrations WHERE module = ${m.module}`.execute(db.query);
    const applied = row.rows[0]?.v ?? 0;
    const known = Math.max(0, ...m.migrations.map((x) => x.version));
    if (applied > known) throw new Error(`schema of module '${m.module}' is v${applied} but this server knows v${known}; refusing to start (06 §8)`);
    plan.push({ module: m.module, pending: m.migrations.filter((x) => x.version > applied).sort((a, b) => a.version - b.version) });
  }
  for (const { module, pending } of plan) {
    for (const mig of pending) {
      // SQLite DDL is transactional: a failing migration leaves no partial schema.
      await db.transaction(async (tx) => {
        await mig.up(tx);
        await sql`INSERT INTO _migrations (module, version, name, applied_at) VALUES (${module}, ${mig.version}, ${mig.name}, ${Date.now()})`.execute(tx);
      });
      log(`  applied ${module} v${mig.version} ${mig.name}`);
    }
  }
}
