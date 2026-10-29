// SPDX-License-Identifier: AGPL-3.0-or-later
import { boot, type RunningApp } from "../boot.js";
import type { CoreConfig } from "../config/schema.js";

/**
 * Boots the modules without listening, for admin commands that need module logic (reindex, permission
 * explanations, reset codes) and not just tables. Safe next to a running server: SQLite serialises the
 * writers, and the outbox is idempotent (05 §3.1).
 */
export async function withRuntime<T>(config: CoreConfig, fn: (app: RunningApp) => Promise<T>): Promise<T> {
  const quiet: CoreConfig = { ...config, log: { level: config.log.level === "silent" ? "silent" : "warn" } };
  const app = await boot({ config: quiet, listen: false, backupBeforeMigrate: false });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}
