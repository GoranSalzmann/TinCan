// SPDX-License-Identifier: AGPL-3.0-or-later
import { monotonicFactory } from "ulidx";

/** ULID text IDs (03 ADR-016): time-sortable, usable as pagination cursors. */
const factory = monotonicFactory();

export function newId(at?: number): string {
  return factory(at);
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function isId(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}
