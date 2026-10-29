// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `channels` (06 §3.4). */
export interface ChannelsTables {
  channel_category: {
    id: string;
    space_id: string;
    name: string;
    position: number;
  };
  channel: {
    id: string;
    space_id: string;
    category_id: string | null;
    type: string;
    name: string;
    topic: string | null;
    position: number;
    created_at: number;
    archived_at: number | null;
    /** JSON text: type-specific settings (slowmode seconds …). */
    settings: string;
  };
}

export const channelsMigrations: ModuleMigrations = {
  module: "channels",
  tables: ["channel_category", "channel"],
  migrations: [
    {
      version: 1,
      name: "categories and channels",
      async up(db) {
        await db.schema
          .createTable("channel_category")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("space_id", "text", (c) => c.notNull())
          .addColumn("name", "text", (c) => c.notNull())
          .addColumn("position", "integer", (c) => c.notNull())
          .execute();
        await db.schema
          .createTable("channel")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("space_id", "text", (c) => c.notNull())
          .addColumn("category_id", "text", (c) => c.references("channel_category.id").onDelete("set null"))
          .addColumn("type", "text", (c) => c.notNull())
          .addColumn("name", "text", (c) => c.notNull())
          .addColumn("topic", "text")
          .addColumn("position", "integer", (c) => c.notNull())
          .addColumn("created_at", "integer", (c) => c.notNull())
          .addColumn("archived_at", "integer")
          .addColumn("settings", "text", (c) => c.notNull().defaultTo("{}"))
          .execute();
        await db.schema.createIndex("channel_category_idx").on("channel").column("category_id").execute();
      },
    },
  ],
};
