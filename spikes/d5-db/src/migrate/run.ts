// Demonstrates the Kysely module-migration pattern: apply, re-run (no-op),
// add a v2, refuse a downgrade, roll back a failing migration.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { createDb } from "../outbox/db.js";
import { migrate, type ModuleMigrations } from "./kysely-runner.js";

const core: ModuleMigrations = { module: "core", migrations: [
  { version: 1, name: "outbox", up: (db) => db.schema.createTable("outbox")
    .addColumn("id", "text", (c) => c.primaryKey()).addColumn("topic", "text", (c) => c.notNull())
    .addColumn("payload", "text", (c) => c.notNull()).addColumn("request_id", "text")
    .addColumn("created_at", "integer", (c) => c.notNull()).execute() },
] };
const textChatV1: ModuleMigrations = { module: "text-chat", migrations: [
  { version: 1, name: "message", up: async (db) => {
    await db.schema.createTable("message")
      .addColumn("id", "text", (c) => c.primaryKey()).addColumn("channel_id", "text", (c) => c.notNull())
      .addColumn("author_id", "text", (c) => c.notNull()).addColumn("content", "text", (c) => c.notNull())
      .addColumn("reply_to_id", "text").addColumn("created_at", "integer", (c) => c.notNull())
      .addColumn("edited_at", "integer").addColumn("deleted_at", "integer")
      .addColumn("flags", "integer", (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.createIndex("message_channel").on("message").columns(["channel_id", "id"]).execute();
  } },
] };
const search: ModuleMigrations = { module: "search", migrations: [
  { version: 1, name: "fts", up: async (db) => {
    // Engine-specific DDL is just sql`` inside the same migration list.
    await sql`CREATE VIRTUAL TABLE message_fts USING fts5(content, channel_id UNINDEXED, message_id UNINDEXED)`.execute(db);
    await db.schema.createTable("search_doc").addColumn("fts_rowid", "integer", (c) => c.primaryKey())
      .addColumn("message_id", "text", (c) => c.notNull().unique()).execute();
  } },
] };
const textChatV2: ModuleMigrations = { module: "text-chat", migrations: [
  ...textChatV1.migrations,
  { version: 2, name: "message.pinned_at", up: (db) => db.schema.alterTable("message").addColumn("pinned_at", "integer").execute() },
] };

const path = join(mkdtempSync(join(tmpdir(), "d5mig-")), "m.db");
const db = createDb(path, { schema: false });
const tables = () => (db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table') AND name NOT LIKE 'message_fts_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name).join(", ");

console.log("1. fresh database");
await migrate(db, [core, textChatV1, search]);
console.log(`  tables: ${tables()}`);
console.log("2. same server restarts (nothing pending)");
await migrate(db, [core, textChatV1, search]);
console.log("3. upgrade ships text-chat v2");
await migrate(db, [core, textChatV2, search]);
console.log(`  message columns: ${(db.sqlite.prepare("SELECT name FROM pragma_table_info('message')").all() as { name: string }[]).map((r) => r.name).join(", ")}`);
console.log("4. older server binary starts on the upgraded database");
try { await migrate(db, [core, textChatV1, search]); } catch (e) { console.log(`  refused: ${(e as Error).message}`); }
console.log("5. a migration that fails half-way");
const broken: ModuleMigrations = { module: "core", migrations: [...core.migrations,
  { version: 2, name: "broken", up: async (d) => { await d.schema.createTable("half_done").addColumn("x", "integer").execute(); await sql`SELEC nonsense`.execute(d); } }] };
try { await migrate(db, [broken]); } catch (e) { console.log(`  failed: ${(e as Error).message.split("\n")[0]}`); }
console.log(`  half_done table exists afterwards: ${tables().includes("half_done")}; core version recorded: ${(db.sqlite.prepare("SELECT max(version) v FROM _migrations WHERE module = 'core'").get() as { v: number }).v}`);
await db.close();
