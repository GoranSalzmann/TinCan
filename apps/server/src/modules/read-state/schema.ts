// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `read-state` (06 §3.8). */
export interface ReadStateTables {
  read_state: {
    user_id: string;
    channel_id: string;
    last_read_message_id: string;
    updated_at: number;
  };
}

export const readStateMigrations: ModuleMigrations = {
  module: "read-state",
  tables: ["read_state"],
  migrations: [
    {
      version: 1,
      name: "read state",
      async up(db) {
        await db.schema
          .createTable("read_state")
          .addColumn("user_id", "text", (c) => c.notNull().references("user.id").onDelete("cascade"))
          .addColumn("channel_id", "text", (c) => c.notNull().references("channel.id").onDelete("cascade"))
          .addColumn("last_read_message_id", "text", (c) => c.notNull())
          .addColumn("updated_at", "integer", (c) => c.notNull())
          .addPrimaryKeyConstraint("read_state_pk", ["user_id", "channel_id"])
          .execute();
      },
    },
  ],
};
