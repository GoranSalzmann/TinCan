// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `accounts` (06 §3.1, §3.2). Timestamps are epoch milliseconds, booleans 0/1. */
export interface AccountsTables {
  user: {
    id: string;
    /** Lowercase, unique. */
    username: string;
    display_username: string;
    display_name: string;
    avatar_key: string | null;
    status_text: string | null;
    /** Null for accounts that cannot log in with a password. */
    password_hash: string | null;
    created_at: number;
    disabled_at: number | null;
    is_instance_owner: number;
  };
  session: {
    id: string;
    user_id: string;
    /** SHA-256 hex of the opaque token; the token itself is never stored. */
    token_hash: string;
    created_at: number;
    last_used_at: number;
    expires_at: number;
    client_name: string;
    ip_hash: string;
    user_agent: string;
    revoked_at: number | null;
  };
  space: {
    id: string;
    name: string;
    icon_key: string | null;
    created_at: number;
    owner_user_id: string;
  };
  member: {
    space_id: string;
    user_id: string;
    joined_at: number;
    nickname: string | null;
    timeout_until: number | null;
    invited_by: string | null;
  };
}

export const accountsMigrations: ModuleMigrations = {
  module: "accounts",
  tables: ["user", "session", "space", "member"],
  migrations: [
    {
      version: 1,
      name: "users, sessions, space, members",
      async up(db) {
        await db.schema
          .createTable("user")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("username", "text", (c) => c.notNull().unique())
          .addColumn("display_username", "text", (c) => c.notNull())
          .addColumn("display_name", "text", (c) => c.notNull())
          .addColumn("avatar_key", "text")
          .addColumn("status_text", "text")
          .addColumn("password_hash", "text")
          .addColumn("created_at", "integer", (c) => c.notNull())
          .addColumn("disabled_at", "integer")
          .addColumn("is_instance_owner", "integer", (c) => c.notNull().defaultTo(0))
          .execute();
        // Exactly one instance owner: the database refuses a second even if two setups race (11 §1.4).
        await db.schema
          .createIndex("user_one_owner")
          .on("user")
          .column("is_instance_owner")
          .unique()
          .where("is_instance_owner", "=", 1)
          .execute();

        await db.schema
          .createTable("session")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("user_id", "text", (c) => c.notNull().references("user.id").onDelete("cascade"))
          .addColumn("token_hash", "text", (c) => c.notNull().unique())
          .addColumn("created_at", "integer", (c) => c.notNull())
          .addColumn("last_used_at", "integer", (c) => c.notNull())
          .addColumn("expires_at", "integer", (c) => c.notNull())
          .addColumn("client_name", "text", (c) => c.notNull())
          .addColumn("ip_hash", "text", (c) => c.notNull())
          .addColumn("user_agent", "text", (c) => c.notNull())
          .addColumn("revoked_at", "integer")
          .execute();
        await db.schema.createIndex("session_user").on("session").column("user_id").execute();
        await db.schema.createIndex("session_expires").on("session").column("expires_at").execute();

        await db.schema
          .createTable("space")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("name", "text", (c) => c.notNull())
          .addColumn("icon_key", "text")
          .addColumn("created_at", "integer", (c) => c.notNull())
          .addColumn("owner_user_id", "text", (c) => c.notNull().references("user.id"))
          .execute();

        await db.schema
          .createTable("member")
          .addColumn("space_id", "text", (c) => c.notNull().references("space.id").onDelete("cascade"))
          .addColumn("user_id", "text", (c) => c.notNull().references("user.id").onDelete("cascade"))
          .addColumn("joined_at", "integer", (c) => c.notNull())
          .addColumn("nickname", "text")
          .addColumn("timeout_until", "integer")
          .addColumn("invited_by", "text")
          .addPrimaryKeyConstraint("member_pk", ["space_id", "user_id"])
          .execute();
      },
    },
  ],
};
