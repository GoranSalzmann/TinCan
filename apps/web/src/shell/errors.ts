// SPDX-License-Identifier: AGPL-3.0-or-later
import { ApiError } from "../core/api/client.js";
import type { MessageKey, Values } from "../core/i18n/index.js";

type T = (key: MessageKey, values?: Values) => string;

const KNOWN = new Set([
  "UNAUTHENTICATED",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
  "PERMISSION_DENIED",
  "CONFLICT",
  "INTERNAL",
  "UNAVAILABLE",
  "NETWORK",
]);

/** Maps an error's stable `code` to a localised message (07 §2.2: `message` is a fallback, `code` drives i18n). */
export function describeError(t: T, err: unknown): string {
  if (err instanceof ApiError && KNOWN.has(err.code)) return t(`error.${err.code}` as MessageKey);
  return t("error.INTERNAL");
}
