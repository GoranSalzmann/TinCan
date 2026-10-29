// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Db, ModuleMigrations } from "./port.js";

/**
 * Shared database contract (16 §3). Every adapter must pass this suite.
 * v1 runs it on SQLite only. Search and outbox catch-up join with the `search` module (M2).
 */
export interface DbHarness {
  db: Db;
  /** Directory the adapter can write snapshots into; undefined for stores without files. */
  scratchDir?: string;
  cleanup(): Promise<void>;
}

interface Items {
  items: { id: string; tag: string; n: number };
  parents: { id: string };
  children: { id: string; parent_id: string };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const itemsMigration: ModuleMigrations = {
  module: "contract",
  tables: ["items", "parents", "children"],
  migrations: [
    {
      version: 1,
      name: "tables",
      async up(db) {
        await db.schema
          .createTable("items")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("tag", "text", (c) => c.notNull())
          .addColumn("n", "integer", (c) => c.notNull())
          .execute();
        await db.schema
          .createTable("parents")
          .addColumn("id", "text", (c) => c.primaryKey())
          .execute();
        await db.schema
          .createTable("children")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("parent_id", "text", (c) => c.notNull().references("parents.id"))
          .execute();
        await db.schema.createIndex("items_tag_unique").unique().on("items").column("tag").execute();
      },
    },
  ],
};

export function runDbContract(name: string, make: () => Promise<DbHarness>): void {
  describe(`db contract: ${name}`, () => {
    let h: DbHarness;
    let db: Db<Items>;

    beforeEach(async () => {
      h = await make();
      await h.db.migrate([itemsMigration]);
      db = h.db.as<Items>();
    });
    afterEach(async () => {
      await h.db.close();
      await h.cleanup();
    });

    it("inserts, reads, updates and deletes", async () => {
      await db.query.insertInto("items").values({ id: "a", tag: "x", n: 1 }).execute();
      expect(await db.query.selectFrom("items").selectAll().execute()).toEqual([{ id: "a", tag: "x", n: 1 }]);
      await db.query.updateTable("items").set({ n: 2 }).where("id", "=", "a").execute();
      expect((await db.query.selectFrom("items").select("n").executeTakeFirstOrThrow()).n).toBe(2);
      await db.query.deleteFrom("items").where("id", "=", "a").execute();
      expect(await db.query.selectFrom("items").selectAll().execute()).toEqual([]);
    });

    it("enforces unique constraints and foreign keys", async () => {
      await db.query.insertInto("items").values({ id: "a", tag: "dup", n: 1 }).execute();
      await expect(
        db.query.insertInto("items").values({ id: "b", tag: "dup", n: 2 }).execute(),
      ).rejects.toThrow();
      await expect(
        db.query.insertInto("children").values({ id: "c", parent_id: "missing" }).execute(),
      ).rejects.toThrow();
    });

    it("commits a transaction and rolls one back when the callback throws", async () => {
      await db.transaction(async (tx) => {
        await tx.query.insertInto("items").values({ id: "a", tag: "kept", n: 1 }).execute();
      });
      await expect(
        db.transaction(async (tx) => {
          await tx.query.insertInto("items").values({ id: "b", tag: "lost", n: 2 }).execute();
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const tags = (await db.query.selectFrom("items").select("tag").execute()).map((r) => r.tag);
      expect(tags).toEqual(["kept"]);
    });

    it("rolls back everything when a later statement violates a constraint", async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.query.insertInto("parents").values({ id: "p" }).execute();
          await tx.query.insertInto("children").values({ id: "c", parent_id: "nope" }).execute();
        }),
      ).rejects.toThrow();
      expect(await db.query.selectFrom("parents").selectAll().execute()).toEqual([]);
    });

    it("joins a nested transaction() call on the tx handle", async () => {
      await db.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.query.insertInto("items").values({ id: "a", tag: "nested", n: 1 }).execute();
        });
      });
      expect(await db.query.selectFrom("items").selectAll().execute()).toHaveLength(1);
    });

    it("throws when the root handle is used inside a transaction, instead of deadlocking", async () => {
      await expect(
        db.transaction(async () => {
          await db.query.selectFrom("items").selectAll().execute();
        }),
      ).rejects.toThrow(/root handle/);
      await expect(
        db.transaction(async () => {
          await db.transaction(async () => undefined);
        }),
      ).rejects.toThrow(/join/);
      // and the connection is usable afterwards
      expect(await db.query.selectFrom("items").selectAll().execute()).toEqual([]);
    });

    it("never interleaves concurrent requests with an open transaction (300 requests, 25% rolled back)", async () => {
      const N = 300;
      const observedUncommitted: string[] = [];
      let readers = 0;
      const work = Array.from({ length: N }, (_, i) => async () => {
        const rollback = i % 4 === 0;
        const tag = `t${i}`;
        const run = db.transaction(async (tx) => {
          await tx.query
            .insertInto("items")
            .values({ id: `${tag}-1`, tag: `${tag}-1`, n: i })
            .execute();
          await sleep(i % 3); // an await inside the transaction: everything else must wait
          await tx.query
            .insertInto("items")
            .values({ id: `${tag}-2`, tag: `${tag}-2`, n: i })
            .execute();
          if (rollback) throw new Error("rollback");
        });
        const reader = async () => {
          readers++;
          const rows = await db.query.selectFrom("items").select(["tag", "n"]).execute();
          // a reader sees a request's rows either both or not at all, and never a rolled-back one
          const byN = new Map<number, number>();
          for (const r of rows) byN.set(r.n, (byN.get(r.n) ?? 0) + 1);
          for (const [n, count] of byN) {
            if (count !== 2 || n % 4 === 0) observedUncommitted.push(`n=${n} count=${count}`);
          }
        };
        await Promise.allSettled([run, reader()]);
      });
      await Promise.all(work.map((w) => w()));
      expect(readers).toBe(N);
      expect(observedUncommitted).toEqual([]);
      const rows = await db.query.selectFrom("items").select(["tag", "n"]).execute();
      expect(rows).toHaveLength((N - Math.ceil(N / 4)) * 2);
      expect(rows.some((r) => r.n % 4 === 0)).toBe(false);
    });

    it("orders by id for cursor pagination", async () => {
      const ids = ["01A", "01B", "01C", "01D", "01E"];
      for (const id of [...ids].reverse()) {
        await db.query.insertInto("items").values({ id, tag: id, n: 0 }).execute();
      }
      const page = await db.query
        .selectFrom("items")
        .select("id")
        .where("id", "<", "01D")
        .orderBy("id", "desc")
        .limit(2)
        .execute();
      expect(page.map((r) => r.id)).toEqual(["01C", "01B"]);
    });

    it("answers health()", async () => {
      await expect(db.health()).resolves.toBeUndefined();
    });

    it("snapshots a consistent copy", async (ctx) => {
      if (!h.scratchDir) return ctx.skip();
      await db.query.insertInto("items").values({ id: "a", tag: "snap", n: 7 }).execute();
      const dest = `${h.scratchDir}/snap.db`;
      await db.snapshot(dest);
      expect(existsSync(dest)).toBe(true);
      expect(existsSync(`${dest}.tmp-${process.pid}`)).toBe(false);
    });

    it("reads committed rows on the worker connection, with bound parameters, and refuses writes", async (ctx) => {
      if (!h.scratchDir) return ctx.skip();
      await db.query.insertInto("items").values({ id: "r1", tag: "worker", n: 1 }).execute();
      const rows = await db.readOnly<{ id: string }>("SELECT id FROM items WHERE tag = ?", ["worker"]);
      expect(rows).toEqual([{ id: "r1" }]);
      // Rows committed after the worker started are visible to its next statement (WAL).
      await db.query.insertInto("items").values({ id: "r2", tag: "worker-2", n: 2 }).execute();
      expect(
        (await db.readOnly("SELECT id FROM items WHERE tag LIKE ? ORDER BY id", ["worker%"])).length,
      ).toBe(2);
      await expect(db.readOnly("DELETE FROM items")).rejects.toThrow(/returns rows/);
      // A bad statement fails that call only; the worker keeps serving.
      await expect(db.readOnly("SELEC nonsense")).rejects.toThrow();
      expect((await db.readOnly("SELECT 1 AS one"))[0]).toEqual({ one: 1 });
    });

    it("refuses readOnly() inside a transaction", async (ctx) => {
      if (!h.scratchDir) return ctx.skip();
      await expect(db.transaction((tx) => tx.readOnly("SELECT 1"))).rejects.toThrow();
    });
  });

  describe(`db migrations contract: ${name}`, () => {
    let h: DbHarness;
    beforeEach(async () => {
      h = await make();
    });
    afterEach(async () => {
      await h.db.close();
      await h.cleanup();
    });

    const mod = (
      module: string,
      versions: { version: number; name: string; sql: string }[],
    ): ModuleMigrations => ({
      module,
      migrations: versions.map((v) => ({
        version: v.version,
        name: v.name,
        async up(db: Kysely<unknown>) {
          await sql.raw(v.sql).execute(db);
        },
      })),
    });

    const tables = async () =>
      (
        await sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`.execute(
          h.db.query,
        )
      ).rows.map((r) => r.name);

    it("applies migrations in order, once, and records them per module", async () => {
      const m = mod("m", [
        { version: 2, name: "second", sql: "ALTER TABLE a ADD COLUMN x TEXT" },
        { version: 1, name: "first", sql: "CREATE TABLE a (id TEXT PRIMARY KEY)" },
      ]);
      const log: string[] = [];
      await h.db.migrate([m], { log: (l) => log.push(l) });
      expect(log).toEqual(["applied m v1 first", "applied m v2 second"]);
      await h.db.migrate([m], { log: (l) => log.push(l) });
      expect(log).toHaveLength(2);
      expect(await tables()).toEqual(["_migrations", "a"]);
    });

    it("keeps modules independent: a module that is not listed leaves no tables", async () => {
      await h.db.migrate([mod("a", [{ version: 1, name: "t", sql: "CREATE TABLE ta (id TEXT)" }])]);
      expect(await tables()).toEqual(["_migrations", "ta"]);
    });

    it("leaves nothing behind when a migration fails", async () => {
      const bad = mod("bad", [
        { version: 1, name: "ok", sql: "CREATE TABLE b1 (id TEXT)" },
        { version: 2, name: "broken", sql: "CREATE TABLE b2 (id TEXT); INSERT INTO nowhere VALUES (1)" },
      ]);
      await expect(h.db.migrate([bad])).rejects.toThrow();
      expect(await tables()).toEqual(["_migrations", "b1"]);
      const applied = (
        await sql<{ version: number }>`SELECT version FROM _migrations WHERE module = 'bad'`.execute(
          h.db.query,
        )
      ).rows;
      expect(applied.map((r) => r.version)).toEqual([1]);
    });

    it("refuses a database whose schema is newer than the server", async () => {
      const newer = mod("m", [
        { version: 1, name: "one", sql: "CREATE TABLE a (id TEXT)" },
        { version: 2, name: "two", sql: "CREATE TABLE a2 (id TEXT)" },
      ]);
      await h.db.migrate([newer]);
      const older = mod("m", [{ version: 1, name: "one", sql: "CREATE TABLE a (id TEXT)" }]);
      await expect(h.db.migrate([older])).rejects.toThrow(/newer|only knows v1/);
    });

    it("reports pending migrations and calls beforeApply once, before anything is applied", async () => {
      const m = mod("m", [
        { version: 1, name: "one", sql: "CREATE TABLE a (id TEXT)" },
        { version: 2, name: "two", sql: "CREATE TABLE a2 (id TEXT)" },
      ]);
      expect((await h.db.pendingMigrations([m])).map((p) => p.version)).toEqual([1, 2]);
      let calls = 0;
      await h.db.migrate([m], {
        beforeApply: async (pending) => {
          calls++;
          expect(pending).toHaveLength(2);
          expect(await tables()).toEqual(["_migrations"]);
        },
      });
      expect(calls).toBe(1);
      await h.db.migrate([m], { beforeApply: async () => void calls++ });
      expect(calls).toBe(1);
    });

    it("rejects duplicate versions", async () => {
      const dup = mod("m", [
        { version: 1, name: "a", sql: "SELECT 1" },
        { version: 1, name: "b", sql: "SELECT 1" },
      ]);
      await expect(h.db.migrate([dup])).rejects.toThrow(/two v1/);
    });
  });
}
