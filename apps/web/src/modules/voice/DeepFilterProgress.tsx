// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { useT } from "../../core/i18n/index.js";
import { deepFilterManifest } from "../../core/voice/deepfilter/index.js";
import { useDeepFilterStatus } from "../../core/voice/deepfilter/status.js";

const mb = (bytes: number) => Math.round(bytes / 100_000) / 10;

/** The first-use download of DeepFilterNet and the model load after it; nothing at other times. */
export function DeepFilterProgress() {
  const t = useT();
  const { phase, loaded, total } = useDeepFilterStatus();
  if (phase === "downloading") {
    return (
      <div className="flex flex-col gap-1 text-xs text-text-muted">
        <span>{t("voice.deepfilter.downloading", { loaded: mb(loaded), total: mb(total) })}</span>
        {/* The text above changes with every chunk, so it is not a live region; the bar carries the value. */}
        <progress
          value={loaded}
          max={total || 1}
          aria-label={t("voice.deepfilter.downloadingLabel")}
          className="h-1.5 w-full"
        />
      </div>
    );
  }
  if (phase === "starting") {
    return (
      <div role="status" className="text-xs text-text-muted">
        {t("voice.deepfilter.starting")}
      </div>
    );
  }
  return null;
}

/** Under the noise suppression choice: how much the first use downloads, or that this server does not have it. */
export function DeepFilterNote() {
  const t = useT();
  const [state, setState] = useState<{ size: number } | "missing" | null>(null);
  useEffect(() => {
    let live = true;
    deepFilterManifest().then(
      (m) => live && setState({ size: Math.round((m.wasm + m.model) / 1_000_000) }),
      () => live && setState("missing"),
    );
    return () => {
      live = false;
    };
  }, []);
  if (state === null) return null;
  if (state === "missing") return <>{t("voice.deepfilter.missing")}</>;
  return <>{t("voice.deepfilter.size", { size: state.size })}</>;
}
