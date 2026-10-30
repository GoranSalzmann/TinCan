// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `moderation` (06 §3.10). Timestamps are epoch milliseconds. */
export interface ModerationTables {
  audit_log: {
    /** Time-ordered ID, so paging by ID is paging by time. */
    id: string;
    at: number;
    actor_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    reason: string | null;
    /** JSON object of action-specific facts; never secrets or message text. */
    data: string;
  };
  ban: {
    user_id: string;
    reason: string | null;
    banned_by: string | null;
    banned_at: number;
  };
}

export const moderationMigrations: ModuleMigrations = {
  module: "moderation",
  tables: ["audit_log", "ban"],
  migrations: [
    {
      version: 1,
      name: "audit log and bans",
      async up(db) {
        await db.schema
          .createTable("audit_log")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("at", "integer", (c) => c.notNull())
          .addColumn("actor_id", "text")
          .addColumn("action", "text", (c) => c.notNull())
          .addColumn("target_type", "text")
          .addColumn("target_id", "text")
          .addColumn("reason", "text")
          .addColumn("data", "text", (c) => c.notNull().defaultTo("{}"))
          .execute();
        await db.schema.createIndex("audit_log_action").on("audit_log").columns(["action", "id"]).execute();
        await db.schema.createIndex("audit_log_actor").on("audit_log").columns(["actor_id", "id"]).execute();
        await db.schema
          .createIndex("audit_log_target")
          .on("audit_log")
          .columns(["target_id", "id"])
          .execute();
        await db.schema
          .createTable("ban")
          .addColumn("user_id", "text", (c) => c.primaryKey())
          .addColumn("reason", "text")
          .addColumn("banned_by", "text")
          .addColumn("banned_at", "integer", (c) => c.notNull())
          .execute();
      },
    },
  ],
};
