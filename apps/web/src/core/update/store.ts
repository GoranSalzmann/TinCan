// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { api } from "../api/client.js";
import { isVersionMismatch } from "./version.js";

/**
 * Whether this tab runs an older build than the server (or lost a file of its own build). The banner
 * reads it; the checks run when the gateway reconnects and when the tab becomes visible again.
 */

export type UpdateReason = "version" | "stale";

interface UpdateState {
  reason: UpdateReason | null;
  /** The server's version that triggered the banner. */
  serverVersion: string | null;
  dismissed: boolean;
  dismiss: () => void;
  /** A chunk of this build is gone from the server; the page can no longer be trusted to work. */
  markStale: () => void;
  /** Asks the server for its version. `force` skips the rate limit (a reconnect after a drop). */
  check: (opts?: { force?: boolean; now?: number; attempt?: number }) => Promise<void>;
}

/** Focus and visibility events come in bursts, and a once-a-minute tick must not be skipped by timer jitter: ask at most this often. */
export const CHECK_INTERVAL_MS = 30_000;
/** A request that has not answered by now is given up on (a dead connection can hang for minutes). */
export const CHECK_TIMEOUT_MS = 10_000;
/** After a failed check (the server is still starting): try again after these waits, then leave it to the periodic check. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

let lastCheck = 0;
let running: { abort: AbortController; id: number } | null = null;
let seq = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function stopRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  reason: null,
  serverVersion: null,
  dismissed: false,
  dismiss: () => set({ dismissed: true }),
  markStale: () => set({ reason: "stale", dismissed: false }),
  async check({ force = false, now = Date.now(), attempt = 0 } = {}) {
    if (!force && (running || now - lastCheck < CHECK_INTERVAL_MS)) return;
    // A forced check (the gateway just came back) replaces one that may be hanging on a dead connection.
    running?.abort.abort();
    stopRetry();
    lastCheck = now;
    const mine = { abort: new AbortController(), id: ++seq };
    running = mine;
    const timeout = setTimeout(() => mine.abort.abort(), CHECK_TIMEOUT_MS);
    try {
      const { server } = await api.capabilities(mine.abort.signal);
      if (running !== mine) return;
      if (isVersionMismatch(server.version)) {
        // A dismissal holds until the next check that still finds a difference, or a newer release.
        set({ reason: get().reason ?? "version", serverVersion: server.version, dismissed: false });
      } else if (get().reason === "version") {
        set({ reason: null, serverVersion: null, dismissed: false });
      }
    } catch {
      // Unreachable or mid-deploy: look again shortly instead of waiting for the next visit to the tab.
      const delay = RETRY_DELAYS_MS[attempt];
      if (running === mine && delay !== undefined) {
        retryTimer = setTimeout(
          () => void get().check({ force: true, attempt: attempt + 1, now: Date.now() }),
          delay,
        );
      }
    } finally {
      clearTimeout(timeout);
      if (running === mine) running = null;
    }
  },
}));

/** Test hook: forget the rate limit and any banner between cases. */
export function resetUpdateChecks(): void {
  lastCheck = 0;
  running?.abort.abort();
  running = null;
  stopRetry();
  useUpdate.setState({ reason: null, serverVersion: null, dismissed: false });
}
