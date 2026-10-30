// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModuleMigrations } from "@tincan/db";

/** Tables owned by `voice`. */
export interface VoiceTables {
  /** Limits the owner changed at runtime; a missing key means the config value applies. */
  voice_setting: {
    key: string;
    value: number;
    updated_at: number;
  };
  /** Server mute and deafen (11 §3): stays until a moderator clears it. */
  voice_restriction: {
    user_id: string;
    muted: number;
    deafened: number;
    set_by: string | null;
    set_at: number;
  };
  /** Text secrets: the E2EE salt (10 §4.1). */
  voice_secret: {
    key: string;
    value: string;
    updated_at: number;
  };
}

export const voiceMigrations: ModuleMigrations = {
  module: "voice",
  tables: ["voice_setting", "voice_restriction", "voice_secret"],
  migrations: [
    {
      version: 1,
      name: "voice-settings",
      async up(db) {
        await db.schema
          .createTable("voice_setting")
          .addColumn("key", "text", (c) => c.primaryKey())
          .addColumn("value", "integer", (c) => c.notNull())
          .addColumn("updated_at", "integer", (c) => c.notNull())
          .execute();
      },
    },
    {
      version: 2,
      name: "server mute and deafen, E2EE salt",
      async up(db) {
        await db.schema
          .createTable("voice_restriction")
          .addColumn("user_id", "text", (c) => c.primaryKey())
          .addColumn("muted", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("deafened", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("set_by", "text")
          .addColumn("set_at", "integer", (c) => c.notNull())
          .execute();
        await db.schema
          .createTable("voice_secret")
          .addColumn("key", "text", (c) => c.primaryKey())
          .addColumn("value", "text", (c) => c.notNull())
          .addColumn("updated_at", "integer", (c) => c.notNull())
          .execute();
      },
    },
  ],
};
