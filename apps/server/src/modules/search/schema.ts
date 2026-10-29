// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql, type ModuleMigrations } from "@tincan/db";

/** Tables owned by `search` (06 §3.9). `message_fts` is a virtual table; Kysely types only `search_doc`. */
export interface SearchTables {
  search_doc: {
    fts_rowid: number;
    message_id: string;
  };
}

/** Shadow tables SQLite creates for an FTS5 table; listed so the boot matrix can prove a clean slate. */
const FTS_SHADOWS = [
  "message_fts_data",
  "message_fts_idx",
  "message_fts_content",
  "message_fts_docsize",
  "message_fts_config",
];

export const searchMigrations: ModuleMigrations = {
  module: "search",
  tables: ["message_fts", ...FTS_SHADOWS, "search_doc"],
  migrations: [
    {
      version: 1,
      name: "message_fts and search_doc",
      async up(db) {
        // `chan` and `author` each hold one ID as a single token, so visibility and the author filter are
        // part of MATCH. Filtering on an UNINDEXED column took 43 s for a channel with no hits in D5; an
        // indexed column took 1 ms. `message_id` is UNINDEXED and reached through `search_doc` (0.9 ms
        // against 0.5 s per edit when looked up in the FTS table).
        await sql`
          CREATE VIRTUAL TABLE message_fts USING fts5(
            content, chan, author, message_id UNINDEXED,
            tokenize = 'unicode61 remove_diacritics 2'
          )
        `.execute(db);
        await sql`
          CREATE TABLE search_doc (
            fts_rowid INTEGER PRIMARY KEY,
            message_id TEXT NOT NULL UNIQUE
          )
        `.execute(db);
      },
    },
  ],
};
