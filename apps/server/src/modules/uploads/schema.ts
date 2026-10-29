// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `uploads` (06 §3.6). */
export interface UploadsTables {
  attachment: {
    id: string;
    /** Null until the message is sent; the orphan GC removes uploads that never got one (06 §6). */
    message_id: string | null;
    /** Where the message lives, copied on attach, so file access needs no other module's tables. */
    channel_id: string | null;
    uploader_id: string;
    storage_key: string;
    filename: string;
    content_type: string;
    size: number;
    width: number | null;
    height: number | null;
    /** 1 when a `<storage_key>.thumb` object exists. */
    has_thumb: number;
    sha256: string;
    created_at: number;
    deleted_at: number | null;
  };
}

export const uploadsMigrations: ModuleMigrations = {
  module: "uploads",
  tables: ["attachment"],
  migrations: [
    {
      version: 1,
      name: "attachments",
      async up(db) {
        await db.schema
          .createTable("attachment")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("message_id", "text")
          .addColumn("channel_id", "text")
          .addColumn("uploader_id", "text", (c) => c.notNull())
          .addColumn("storage_key", "text", (c) => c.notNull())
          .addColumn("filename", "text", (c) => c.notNull())
          .addColumn("content_type", "text", (c) => c.notNull())
          .addColumn("size", "integer", (c) => c.notNull())
          .addColumn("width", "integer")
          .addColumn("height", "integer")
          .addColumn("has_thumb", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("sha256", "text", (c) => c.notNull())
          .addColumn("created_at", "integer", (c) => c.notNull())
          .addColumn("deleted_at", "integer")
          .execute();
        await db.schema.createIndex("attachment_message").on("attachment").column("message_id").execute();
        await db.schema.createIndex("attachment_key").on("attachment").column("storage_key").execute();
        await db.schema
          .createIndex("attachment_uploader")
          .on("attachment")
          .columns(["uploader_id", "deleted_at"])
          .execute();
      },
    },
  ],
};
