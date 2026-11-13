// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `gifs` (issue #33). Timestamps are epoch milliseconds. */
export interface GifTables {
  /** Bookkeeping for re-hosted GIF bytes in storage (`gifs/<provider>/<id>/<variant>`), for the daily purge. */
  gif_media: {
    /** The storage key. */
    key: string;
    content_type: string;
    bytes: number;
    fetched_at: number;
  };
}

export const gifsMigrations: ModuleMigrations = {
  module: "gifs",
  tables: ["gif_media"],
  migrations: [
    {
      version: 1,
      name: "gif media",
      async up(db) {
        await db.schema
          .createTable("gif_media")
          .addColumn("key", "text", (c) => c.primaryKey())
          .addColumn("content_type", "text", (c) => c.notNull())
          .addColumn("bytes", "integer", (c) => c.notNull())
          .addColumn("fetched_at", "integer", (c) => c.notNull())
          .execute();
        await db.schema.createIndex("gif_media_fetched").on("gif_media").column("fetched_at").execute();
      },
    },
  ],
};
