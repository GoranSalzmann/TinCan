// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "./port.js";

/** Tables owned by module `core` (06 §3.14). */
export interface CoreTables {
  outbox: {
    id: string;
    topic: string;
    payload: string;
    request_id: string;
    created_at: number;
  };
}

export const coreMigrations: ModuleMigrations = {
  module: "core",
  tables: ["outbox"],
  migrations: [
    {
      version: 1,
      name: "outbox",
      async up(db) {
        // Written by a use case inside its own transaction; drained in id order (the drain job arrives with search, M2).
        await db.schema
          .createTable("outbox")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("topic", "text", (c) => c.notNull())
          .addColumn("payload", "text", (c) => c.notNull())
          .addColumn("request_id", "text", (c) => c.notNull())
          .addColumn("created_at", "integer", (c) => c.notNull())
          .execute();
      },
    },
  ],
};
