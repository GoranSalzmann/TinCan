// SPDX-License-Identifier: AGPL-3.0-or-later
import type { z } from "zod";
import type { Db } from "@tincan/db";
import { AppError } from "@tincan/shared";
import type { AccountsTables } from "./schema.js";

/**
 * Synced per-user preferences (06 §3.1 `user_setting`). Each key must be registered by the module
 * that owns it, with a schema; last writer wins. Device-local settings never come through here (12 §8).
 */
export class UserSettings {
  readonly #exact = new Map<string, z.ZodType>();
  readonly #prefixes: { prefix: string; schema: z.ZodType }[] = [];
  readonly #db: Db<AccountsTables>;
  readonly #now: () => number;

  constructor(db: Db<AccountsTables>, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  register(keyOrPrefix: string, schema: z.ZodType): void {
    if (keyOrPrefix.endsWith(".*")) this.#prefixes.push({ prefix: keyOrPrefix.slice(0, -1), schema });
    else this.#exact.set(keyOrPrefix, schema);
  }

  #schemaFor(key: string): z.ZodType | undefined {
    return (
      this.#exact.get(key) ??
      this.#prefixes.find((p) => key.startsWith(p.prefix) && key.length > p.prefix.length)?.schema
    );
  }

  async get(userId: string): Promise<Record<string, unknown>> {
    const rows = await this.#db.query
      .selectFrom("user_setting")
      .select(["key", "value"])
      .where("user_id", "=", userId)
      .execute();
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value) as unknown;
      } catch {
        // A row we wrote ourselves; skip rather than fail the whole read.
      }
    }
    return out;
  }

  /** Validates every key first, then writes them together. A null value clears the key. */
  async patch(userId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const accepted: [string, unknown][] = [];
    const problems: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch)) {
      const schema = this.#schemaFor(key);
      if (!schema) {
        problems[key] = "unknown setting";
        continue;
      }
      if (value === null) {
        accepted.push([key, null]);
        continue;
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) problems[key] = parsed.error.issues[0]?.message ?? "invalid value";
      else accepted.push([key, parsed.data]);
    }
    if (Object.keys(problems).length > 0) {
      throw new AppError("VALIDATION_FAILED", "Some settings are not valid.", { fields: problems });
    }
    const now = this.#now();
    await this.#db.transaction(async (tx) => {
      for (const [key, value] of accepted) {
        if (value === null) {
          await tx.query
            .deleteFrom("user_setting")
            .where("user_id", "=", userId)
            .where("key", "=", key)
            .execute();
        } else {
          await tx.query
            .insertInto("user_setting")
            .values({ user_id: userId, key, value: JSON.stringify(value), updated_at: now })
            .onConflict((oc) =>
              oc.columns(["user_id", "key"]).doUpdateSet({ value: JSON.stringify(value), updated_at: now }),
            )
            .execute();
        }
      }
    });
    return Object.fromEntries(accepted);
  }
}
