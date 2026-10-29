// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `roles` (06 §3.2). Permission bitsets are stored as decimal text (18 T7). */
export interface RolesTables {
  role: {
    id: string;
    space_id: string;
    name: string;
    color: string | null;
    position: number;
    permissions: string;
    is_default: number;
    is_managed: number;
    hoist: number;
    created_at: number;
  };
  member_role: {
    space_id: string;
    user_id: string;
    role_id: string;
  };
  /**
   * Per-channel allow/deny for a role or a member. `channel_id` has no foreign key: `channels` depends on
   * `roles`, not the other way round, and deletes a channel's rows through the roles API.
   */
  channel_overwrite: {
    id: string;
    channel_id: string;
    target_type: string;
    target_id: string;
    allow: string;
    deny: string;
  };
}

export const rolesMigrations: ModuleMigrations = {
  module: "roles",
  tables: ["role", "member_role", "channel_overwrite"],
  migrations: [
    {
      version: 1,
      name: "roles, role assignment, channel overwrites",
      async up(db) {
        await db.schema
          .createTable("role")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("space_id", "text", (c) => c.notNull())
          .addColumn("name", "text", (c) => c.notNull())
          .addColumn("color", "text")
          .addColumn("position", "integer", (c) => c.notNull())
          .addColumn("permissions", "text", (c) => c.notNull())
          .addColumn("is_default", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("is_managed", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("hoist", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("created_at", "integer", (c) => c.notNull())
          .execute();
        await db.schema
          .createIndex("role_one_default")
          .on("role")
          .columns(["space_id", "is_default"])
          .unique()
          .where("is_default", "=", 1)
          .execute();

        await db.schema
          .createTable("member_role")
          .addColumn("space_id", "text", (c) => c.notNull())
          .addColumn("user_id", "text", (c) => c.notNull().references("user.id").onDelete("cascade"))
          .addColumn("role_id", "text", (c) => c.notNull().references("role.id").onDelete("cascade"))
          .addPrimaryKeyConstraint("member_role_pk", ["space_id", "user_id", "role_id"])
          .execute();
        await db.schema
          .createIndex("member_role_user")
          .on("member_role")
          .columns(["user_id", "space_id"])
          .execute();

        await db.schema
          .createTable("channel_overwrite")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("channel_id", "text", (c) => c.notNull())
          .addColumn("target_type", "text", (c) => c.notNull())
          .addColumn("target_id", "text", (c) => c.notNull())
          .addColumn("allow", "text", (c) => c.notNull())
          .addColumn("deny", "text", (c) => c.notNull())
          .execute();
        await db.schema
          .createIndex("channel_overwrite_target")
          .on("channel_overwrite")
          .columns(["channel_id", "target_type", "target_id"])
          .unique()
          .execute();
      },
    },
  ],
};
