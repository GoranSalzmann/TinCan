// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDbContract } from "./contract.js";
import { coreMigrations, openSqlite } from "./index.js";

runDbContract("sqlite (file)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tincan-db-"));
  return {
    db: openSqlite({ path: join(dir, "app.db") }),
    scratchDir: dir,
    cleanup: async () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
});

runDbContract("sqlite (memory)", async () => ({
  db: openSqlite({ path: ":memory:" }),
  cleanup: async () => undefined,
}));

describe("sqlite specifics", () => {
  it("sets the pragmas of 05 §3.1 and creates the core tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tincan-db-"));
    const db = openSqlite({ path: join(dir, "app.db") });
    try {
      await db.migrate([coreMigrations]);
      const { sql } = await import("kysely");
      const pragma = async (name: string) =>
        (await sql<Record<string, unknown>>`${sql.raw(`PRAGMA ${name}`)}`.execute(db.query)).rows[0];
      expect(Object.values((await pragma("journal_mode")) ?? {})[0]).toBe("wal");
      expect(Object.values((await pragma("foreign_keys")) ?? {})[0]).toBe(1);
      expect(Object.values((await pragma("auto_vacuum")) ?? {})[0]).toBe(2); // INCREMENTAL
      expect(Object.values((await pragma("busy_timeout")) ?? {})[0]).toBe(5000);
      await db.query
        .selectFrom("outbox" as never)
        .selectAll()
        .execute();
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
