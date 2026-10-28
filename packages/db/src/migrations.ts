// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql, type Kysely } from "kysely";
import type { MigrateOptions, ModuleMigrations, PendingMigration } from "./port.js";

/**
 * Per-module, forward-only migrations (06 §8). Applied versions live in
 * `_migrations(module, version, name, applied_at)`. Plain TS objects, no codegen.
 */

interface Plan {
  module: string;
  pending: ModuleMigrations["migrations"];
}

async function ensureTable(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    module TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (module, version)
  )`.execute(db);
}

function validate(modules: ModuleMigrations[]): void {
  const seen = new Set<string>();
  for (const m of modules) {
    if (seen.has(m.module)) throw new Error(`migrations: module '${m.module}' listed twice`);
    seen.add(m.module);
    const versions = new Set<number>();
    for (const mig of m.migrations) {
      if (!Number.isInteger(mig.version) || mig.version < 1) {
        throw new Error(`migrations: ${m.module} '${mig.name}' has an invalid version ${mig.version}`);
      }
      if (versions.has(mig.version)) throw new Error(`migrations: ${m.module} has two v${mig.version}`);
      versions.add(mig.version);
    }
  }
}

export async function plan(db: Kysely<unknown>, modules: ModuleMigrations[]): Promise<Plan[]> {
  validate(modules);
  await ensureTable(db);
  const plans: Plan[] = [];
  // Downgrade protection first, for every module, before anything is applied.
  for (const m of modules) {
    const row = await sql<{
      v: number | null;
    }>`SELECT max(version) AS v FROM _migrations WHERE module = ${m.module}`.execute(db);
    const applied = row.rows[0]?.v ?? 0;
    const known = Math.max(0, ...m.migrations.map((x) => x.version));
    if (applied > known) {
      throw new Error(
        `The database schema of module '${m.module}' is v${applied}, but this server only knows v${known}. ` +
          `Refusing to start so nothing is damaged (06 §8). Run a newer Tin Can, or restore a backup taken before the upgrade.`,
      );
    }
    plans.push({
      module: m.module,
      pending: m.migrations.filter((x) => x.version > applied).sort((a, b) => a.version - b.version),
    });
  }
  return plans;
}

export function flatten(plans: Plan[]): PendingMigration[] {
  return plans.flatMap((p) => p.pending.map((x) => ({ module: p.module, version: x.version, name: x.name })));
}

export async function runMigrations(
  db: Kysely<unknown>,
  transaction: <R>(fn: (tx: Kysely<unknown>) => Promise<R>) => Promise<R>,
  modules: ModuleMigrations[],
  opts: MigrateOptions = {},
): Promise<void> {
  const plans = await plan(db, modules);
  const pending = flatten(plans);
  if (pending.length === 0) return;
  await opts.beforeApply?.(pending);
  for (const { module, pending: list } of plans) {
    for (const mig of list) {
      // SQLite DDL is transactional: a failing migration leaves no partial schema and no version row.
      await transaction(async (tx) => {
        await mig.up(tx);
        await sql`INSERT INTO _migrations (module, version, name, applied_at)
                  VALUES (${module}, ${mig.version}, ${mig.name}, ${Date.now()})`.execute(tx);
      });
      opts.log?.(`applied ${module} v${mig.version} ${mig.name}`);
    }
  }
}
