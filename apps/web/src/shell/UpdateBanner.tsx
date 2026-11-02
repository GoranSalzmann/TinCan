// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from "react";
import { RefreshCw, X } from "lucide-react";
import { useT } from "../core/i18n/index.js";
import { useSession } from "../core/session/store.js";
import { useUpdate } from "../core/update/store.js";
import { useVoice } from "../core/voice/store.js";
import { Button } from "../ui/Button.js";

/** How often a tab that is shown looks for a new release without anything else prompting it. */
export const PERIODIC_CHECK_MS = 60_000;

/** Asks for the server's version when the gateway comes back after a drop and when the tab is shown again. */
export function useVersionWatch(): void {
  const gateway = useSession((s) => s.gateway);
  const seenReady = useRef(false);
  const dropped = useRef(false);
  useEffect(() => {
    if (gateway === "ready") {
      // The first connect of this page is not a reconnect; the capabilities were just fetched at boot.
      if (seenReady.current && dropped.current) void useUpdate.getState().check({ force: true });
      seenReady.current = true;
      dropped.current = false;
    } else if (seenReady.current) {
      dropped.current = true;
    }
  }, [gateway]);
  // A window that stays in the foreground never changes visibility, so it also asks when it is
  // focused or back online, and once a minute while it is shown. One small GET per minute; it stops
  // once the banner is up for a different version, and nothing is fetched while the tab is hidden.
  useEffect(() => {
    const ask = () => {
      if (document.visibilityState !== "visible") return;
      if (useUpdate.getState().reason === "version") return;
      void useUpdate.getState().check();
    };
    const timer = setInterval(ask, PERIODIC_CHECK_MS);
    document.addEventListener("visibilitychange", ask);
    window.addEventListener("focus", ask);
    window.addEventListener("online", ask);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ask);
      window.removeEventListener("focus", ask);
      window.removeEventListener("online", ask);
    };
  }, []);
}

/**
 * The tab runs an older build than the server. A polite live region that is always in the page, so the
 * message is announced when it appears; it does not take focus or move the content under the pointer.
 */
export function UpdateBanner() {
  const t = useT();
  const reason = useUpdate((s) => s.reason);
  const dismissed = useUpdate((s) => s.dismissed);
  const dismiss = useUpdate((s) => s.dismiss);
  const inCall = useVoice((s) => s.status !== "idle");
  return (
    <div role="status" aria-live="polite">
      {reason !== null && !dismissed ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-bg-elevated px-4 py-2 text-sm text-text">
          <RefreshCw aria-hidden="true" size={16} className="shrink-0 text-accent-text" />
          <p className="min-w-0 flex-1 basis-56">
            {t(reason === "stale" ? "update.stale" : "update.available")}
            {inCall ? ` ${t("update.callLeaves")}` : ""}
          </p>
          <div className="flex items-center gap-1">
            <Button onClick={() => window.location.reload()}>{t("update.reload")}</Button>
            <button
              type="button"
              aria-label={t("update.dismiss")}
              onClick={dismiss}
              className="rounded-md p-1.5 hover:bg-bg-hover"
            >
              <X aria-hidden="true" size={16} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
