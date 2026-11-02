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
  check: (opts?: { force?: boolean; now?: number }) => Promise<void>;
}

/** Visibility changes can come in bursts; ask at most this often. */
export const CHECK_INTERVAL_MS = 60_000;

let lastCheck = 0;
let inFlight = false;

export const useUpdate = create<UpdateState>((set, get) => ({
  reason: null,
  serverVersion: null,
  dismissed: false,
  dismiss: () => set({ dismissed: true }),
  markStale: () => set({ reason: "stale", dismissed: false }),
  async check({ force = false, now = Date.now() } = {}) {
    if (inFlight || (!force && now - lastCheck < CHECK_INTERVAL_MS)) return;
    inFlight = true;
    lastCheck = now;
    try {
      const { server } = await api.capabilities();
      if (isVersionMismatch(server.version)) {
        // A dismissal holds until the next check that still finds a difference, or a newer release.
        set({ reason: get().reason ?? "version", serverVersion: server.version, dismissed: false });
      } else if (get().reason === "version") {
        set({ reason: null, serverVersion: null, dismissed: false });
      }
    } catch {
      // Unreachable or mid-deploy: the next check tries again.
    } finally {
      inFlight = false;
    }
  },
}));

/** Test hook: forget the rate limit and any banner between cases. */
export function resetUpdateChecks(): void {
  lastCheck = 0;
  inFlight = false;
  useUpdate.setState({ reason: null, serverVersion: null, dismissed: false });
}
