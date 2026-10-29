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
}

export const voiceMigrations: ModuleMigrations = {
  module: "voice",
  tables: ["voice_setting"],
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
  ],
};
