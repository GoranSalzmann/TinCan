// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `push`. */
export interface PushTables {
  push_subscription: {
    id: string;
    user_id: string;
    /** The login this browser subscribed under; the row goes when that login is revoked. */
    session_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    created_at: number;
    last_ok_at: number | null;
    fail_count: number;
  };
}

export const pushMigrations: ModuleMigrations = {
  module: "push",
  tables: ["push_subscription"],
  migrations: [
    {
      version: 1,
      name: "push subscriptions",
      async up(db) {
        await db.schema
          .createTable("push_subscription")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("user_id", "text", (c) => c.notNull().references("user.id").onDelete("cascade"))
          .addColumn("session_id", "text", (c) => c.notNull())
          .addColumn("endpoint", "text", (c) => c.notNull().unique())
          .addColumn("p256dh", "text", (c) => c.notNull())
          .addColumn("auth", "text", (c) => c.notNull())
          .addColumn("created_at", "integer", (c) => c.notNull())
          .addColumn("last_ok_at", "integer")
          .addColumn("fail_count", "integer", (c) => c.notNull().defaultTo(0))
          .execute();
        await db.schema
          .createIndex("push_subscription_user")
          .on("push_subscription")
          .column("user_id")
          .execute();
        await db.schema
          .createIndex("push_subscription_session")
          .on("push_subscription")
          .column("session_id")
          .execute();
      },
    },
  ],
};
