// SPDX-License-Identifier: AGPL-3.0-or-later

const KEY = "tincan.autoReloadAt";
/** One automatic reload per minute at most; a second failure inside it means reloading does not help. */
export const RELOAD_WINDOW_MS = 60_000;

/**
 * True when the page may reload itself now, and records the attempt. Without usable storage the
 * guard cannot tell a first failure from a loop, so it refuses.
 */
export function takeAutoReload(now: number, storage?: Pick<Storage, "getItem" | "setItem">): boolean {
  try {
    const store = storage ?? sessionStorage;
    const last = Number(store.getItem(KEY));
    if (Number.isFinite(last) && last > 0 && now >= last && now - last < RELOAD_WINDOW_MS) return false;
    store.setItem(KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
