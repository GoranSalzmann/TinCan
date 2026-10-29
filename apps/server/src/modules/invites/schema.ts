// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `invites` (06 §3.3). */
export interface InvitesTables {
  invite: {
    id: string;
    space_id: string;
    /** URL-safe random, 12 characters (72 bits): a bearer secret (11 §5). */
    code: string;
    created_by: string | null;
    created_at: number;
    expires_at: number | null;
    max_uses: number | null;
    uses: number;
    revoked_at: number | null;
    default_role_id: string | null;
  };
  invite_use: {
    invite_id: string;
    user_id: string;
    used_at: number;
  };
}

export const invitesMigrations: ModuleMigrations = {
  module: "invites",
  tables: ["invite", "invite_use"],
  migrations: [
    {
      version: 1,
      name: "invites and their uses",
      async up(db) {
        await db.schema
          .createTable("invite")
          .addColumn("id", "text", (c) => c.primaryKey())
          .addColumn("space_id", "text", (c) => c.notNull())
          .addColumn("code", "text", (c) => c.notNull().unique())
          .addColumn("created_by", "text")
          .addColumn("created_at", "integer", (c) => c.notNull())
          .addColumn("expires_at", "integer")
          .addColumn("max_uses", "integer")
          .addColumn("uses", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("revoked_at", "integer")
          .addColumn("default_role_id", "text")
          .execute();
        await db.schema
          .createTable("invite_use")
          .addColumn("invite_id", "text", (c) => c.notNull().references("invite.id").onDelete("cascade"))
          .addColumn("user_id", "text", (c) => c.notNull().references("user.id").onDelete("cascade"))
          .addColumn("used_at", "integer", (c) => c.notNull())
          .execute();
        await db.schema.createIndex("invite_use_invite").on("invite_use").column("invite_id").execute();
      },
    },
  ],
};
