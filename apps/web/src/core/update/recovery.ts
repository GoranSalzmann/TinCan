// SPDX-License-Identifier: AGPL-3.0-or-later
import { useVoice } from "../voice/store.js";
import { takeAutoReload } from "./reloadGuard.js";
import { useUpdate } from "./store.js";

/**
 * After a deploy the files this tab was built from are gone from the server, so a lazy chunk fails
 * to load. Reload once to pick up the new build; never mid-call, and never in a loop.
 */

const CHUNK_ERROR = /dynamically imported module|importing a module script failed|error loading dynamically/i;

export function isChunkLoadError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return CHUNK_ERROR.test(message);
}

export function recoverFromChunkError(
  deps: { inCall?: () => boolean; reload?: () => void; now?: () => number } = {},
): "reloaded" | "banner" {
  const inCall = deps.inCall ?? (() => useVoice.getState().status !== "idle");
  // In a call the reload would drop it, and after one failed reload another will not help: the banner offers the button.
  if (!inCall() && takeAutoReload((deps.now ?? Date.now)())) {
    (deps.reload ?? (() => window.location.reload()))();
    return "reloaded";
  }
  useUpdate.getState().markStale();
  return "banner";
}

export function installChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (ev) => {
    ev.preventDefault(); // Vite would rethrow
    recoverFromChunkError();
  });
  window.addEventListener("unhandledrejection", (ev) => {
    if (isChunkLoadError(ev.reason)) recoverFromChunkError();
  });
}
