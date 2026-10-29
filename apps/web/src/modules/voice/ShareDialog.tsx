// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { startScreenShare, updateScreenShare } from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import { useVideoPrefs, type ContentHint } from "../../core/voice/video.js";
import { Button } from "../../ui/Button.js";
import { Modal } from "../../ui/Dialog.js";
import { toastError } from "../../ui/toast.js";
import { QualityControls, mbit } from "./QualityControls.js";

export const mbps = mbit;

/**
 * Web screen share (W-16) and, while live, "Change stream settings" (W-13). The browser shows its own picker after
 * "Continue"; when live, quality and optimisation change in place and audio stays as it was at the start.
 */
export function ShareDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const live = useVoice((s) => s.screenOn);
  const liveAudio = useVoice((s) => s.share?.audio ?? false);
  const prefs = useVideoPrefs((s) => s.prefs);
  const setPrefs = useVideoPrefs((s) => s.set);
  const [busy, setBusy] = useState(false);
  const hints: ContentHint[] = ["detail", "motion"];

  const go = async () => {
    setBusy(true);
    try {
      const o = { hint: prefs.contentHint };
      if (live) await updateScreenShare(o);
      else await startScreenShare({ ...o, audio: prefs.shareAudio });
      onOpenChange(false);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={live ? t("video.share.changeTitle") : t("video.share.title")}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <QualityControls source="screen" />
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 font-medium">{t("video.hint")}</legend>
          {hints.map((h) => (
            <label key={h} className="flex items-center gap-2">
              <input
                type="radio"
                name="screen-hint"
                value={h}
                checked={prefs.contentHint === h}
                onChange={() => setPrefs({ contentHint: h })}
              />
              {t(`video.hint.${h}` as MessageKey)}
            </label>
          ))}
        </fieldset>
        {live ? (
          <p className="m-0 text-sm text-text-muted">
            {liveAudio ? t("video.share.audioOn") : t("video.share.audioOff")}
          </p>
        ) : (
          <>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={prefs.shareAudio}
                onChange={(e) => setPrefs({ shareAudio: e.target.checked })}
              />
              {t("video.share.audio")}
            </label>
            <p className="m-0 text-sm text-text-muted">{t("video.share.browserNote")}</p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {live ? t("video.share.apply") : t("video.share.continue")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
