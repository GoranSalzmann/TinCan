// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `text-chat` (06 §3.5). */
export interface TextChatTables {
  message: {
    id: string;
    channel_id: string;
    author_id: string;
    content: string;
    reply_to_id: string | null;
    created_at: number;
    edited_at: number | null;
    deleted_at: number | null;
    /** Bit 0 pinned, bit 1 system message. */
    flags: number;
  };
  message_mention: {
    message_id: string;
    /** Denormalised so mention counts need no join (06 §3.8). */
    channel_id: string;
    target_type: string;
    target_id: string;
  };
}

export const FLAG_PINNED = 1;

export const textChatMigrations: ModuleMigrations = {
  module: "text-chat",
  tables: ["message", "message_mention"],
  migrations: [
    {
      version: 1,
      name: "messages and mentions",
      async up(db) {
        await db.schema
          .createTable("message")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("channel_id", "text", (c) => c.notNull().references("channel.id").onDelete("cascade"))
          .addColumn("author_id", "text", (c) => c.notNull())
          .addColumn("content", "text", (c) => c.notNull())
          .addColumn("reply_to_id", "text")
          .addColumn("created_at", "integer", (c) => c.notNull())
          .addColumn("edited_at", "integer")
          .addColumn("deleted_at", "integer")
          .addColumn("flags", "integer", (c) => c.notNull().defaultTo(0))
          .execute();
        await db.schema.createIndex("message_channel").on("message").columns(["channel_id", "id"]).execute();
        await db.schema.createIndex("message_author").on("message").columns(["author_id", "id"]).execute();

        await db.schema
          .createTable("message_mention")
          .addColumn("message_id", "text", (c) => c.notNull().references("message.id").onDelete("cascade"))
          .addColumn("channel_id", "text", (c) => c.notNull())
          .addColumn("target_type", "text", (c) => c.notNull())
          .addColumn("target_id", "text", (c) => c.notNull())
          .execute();
        await db.schema
          .createIndex("message_mention_target")
          .on("message_mention")
          .columns(["target_type", "target_id", "channel_id", "message_id"])
          .execute();
        await db.schema
          .createIndex("message_mention_message")
          .on("message_mention")
          .column("message_id")
          .execute();
      },
    },
  ],
};
