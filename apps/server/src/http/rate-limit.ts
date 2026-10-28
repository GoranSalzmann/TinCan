// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyReply } from "fastify";
import { AppError } from "@tincan/shared";
import type { Kv } from "@tincan/pubsub";

export interface RateRule {
  /** Identifies the counter, e.g. `login:ip:1.2.3.4`. */
  key: string;
  max: number;
  windowMs: number;
}

export interface RateResult {
  limit: number;
  remaining: number;
  resetMs: number;
}

/**
 * Fixed-window counter in the pubsub `kv` (05 §4). Throws RATE_LIMITED with `retryAfterMs`
 * once the window is spent. Headers follow 07 §2.4.
 */
export async function enforceRateLimit(kv: Kv, rule: RateRule, reply?: FastifyReply): Promise<RateResult> {
  const key = `rl:${rule.key}`;
  const count = await kv.incr(key, { ttlMs: rule.windowMs });
  const resetMs = (await kv.ttl(key)) ?? rule.windowMs;
  const result: RateResult = { limit: rule.max, remaining: Math.max(0, rule.max - count), resetMs };
  reply?.header("RateLimit-Limit", String(result.limit));
  reply?.header("RateLimit-Remaining", String(result.remaining));
  reply?.header("RateLimit-Reset", String(Math.ceil(resetMs / 1000)));
  if (count > rule.max) {
    reply?.header("Retry-After", String(Math.ceil(resetMs / 1000)));
    throw new AppError("RATE_LIMITED", "Too many attempts. Try again later.", { retryAfterMs: resetMs });
  }
  return result;
}
