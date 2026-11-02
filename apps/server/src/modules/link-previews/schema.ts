// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `link-previews` (23 §8). Timestamps are epoch milliseconds. */
export interface LinkPreviewTables {
  link_preview_cache: {
    /** sha-256 of the URL as written, hex. */
    url_hash: string;
    url: string;
    /** 1 when metadata was found; 0 is a remembered "nothing here" (failed, blocked or empty). */
    ok: number;
    /** JSON of the stored preview fields; null for a negative entry. */
    data: string | null;
    /** sha-256 of the re-hosted image (the storage key is `lp/<hash>`), or null. */
    image_hash: string | null;
    fetched_at: number;
    expires_at: number;
  };
  /** Messages whose previews the author or a moderator removed. */
  link_preview_suppressed: {
    message_id: string;
    by_user: string;
    at: number;
  };
  /** The owner's settings as one JSON value per key. */
  link_preview_setting: {
    key: string;
    value: string;
  };
}

export const linkPreviewsMigrations: ModuleMigrations = {
  module: "link-previews",
  tables: ["link_preview_cache", "link_preview_suppressed", "link_preview_setting"],
  migrations: [
    {
      version: 1,
      name: "link previews",
      async up(db) {
        await db.schema
          .createTable("link_preview_cache")
          .addColumn("url_hash", "text", (c) => c.primaryKey())
          .addColumn("url", "text", (c) => c.notNull())
          .addColumn("ok", "integer", (c) => c.notNull())
          .addColumn("data", "text")
          .addColumn("image_hash", "text")
          .addColumn("fetched_at", "integer", (c) => c.notNull())
          .addColumn("expires_at", "integer", (c) => c.notNull())
          .execute();
        await db.schema
          .createIndex("link_preview_cache_expires")
          .on("link_preview_cache")
          .column("expires_at")
          .execute();
        await db.schema
          .createIndex("link_preview_cache_image")
          .on("link_preview_cache")
          .column("image_hash")
          .execute();
        await db.schema
          .createTable("link_preview_suppressed")
          .addColumn("message_id", "text", (c) => c.primaryKey())
          .addColumn("by_user", "text", (c) => c.notNull())
          .addColumn("at", "integer", (c) => c.notNull())
          .execute();
        await db.schema
          .createTable("link_preview_setting")
          .addColumn("key", "text", (c) => c.primaryKey())
          .addColumn("value", "text", (c) => c.notNull())
          .execute();
      },
    },
  ],
};
