// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from "react";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { startScreenShare, stopScreenShare, updateScreenShare } from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import { useVideoPrefs, type ContentHint } from "../../core/voice/video.js";
import { Button } from "../../ui/Button.js";
import { Modal } from "../../ui/Dialog.js";
import { toastError } from "../../ui/toast.js";
import { QualityControls, mbit } from "./QualityControls.js";
import { HelperAudioPicker, HelperErrorMessage } from "./HelperAudioPicker.js";
import {
  HelperError,
  helperPreferred,
  isLinuxDesktop,
  preferHelper,
  type HelperErrorCode,
  type HelperSelection,
} from "../../core/voice/audio-helper.js";

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
  const [helperMode, setHelperMode] = useState(() => isLinuxDesktop() && helperPreferred());
  const [helper, setHelper] = useState<HelperSelection | null>(null);
  const [error, setError] = useState<HelperErrorCode | null>(null);
  const linux = isLinuxDesktop();
  const attempt = useRef(0);
  const hints: ContentHint[] = ["detail", "motion"];

  const go = async () => {
    if (busy) return;
    const current = ++attempt.current;
    setBusy(true);
    setError(null);
    try {
      const o = { hint: prefs.contentHint };
      if (live) await updateScreenShare(o);
      else {
        if (prefs.shareAudio && helperMode && !helper) return;
        const started = await startScreenShare({
          ...o,
          audio: prefs.shareAudio,
          ...(prefs.shareAudio && helperMode && helper ? { helper } : {}),
        });
        if (!started) return;
      }
      if (attempt.current === current) onOpenChange(false);
    } catch (err) {
      if (attempt.current !== current) return;
      if (err instanceof HelperError) setError(err.code);
      else toastError(err);
    } finally {
      if (attempt.current === current) setBusy(false);
    }
  };
  const dismiss = (next: boolean) => {
    if (!next) {
      attempt.current++;
      if (busy && !live) void stopScreenShare();
      setBusy(false);
      setError(null);
      setHelper(null);
    }
    onOpenChange(next);
  };

  return (
    <Modal
      open={open}
      onOpenChange={dismiss}
      title={live ? t("video.share.changeTitle") : t("video.share.title")}
      wide={!live && prefs.shareAudio && helperMode}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        {helperMode && !live ? (
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              {t("voice.helper.videoSettings")}
              <span className="ms-2 text-text-muted">
                {t(
                  prefs.screenPreset === "custom"
                    ? "video.custom"
                    : (`video.preset.screen.${prefs.screenPreset}` as MessageKey),
                )}
              </span>
            </summary>
            <fieldset disabled={busy} className="m-0 mt-3 min-w-0 border-0 p-0">
              <QualityControls source="screen" />
            </fieldset>
          </details>
        ) : (
          <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
            <QualityControls source="screen" />
          </fieldset>
        )}
        {live ? <p className="m-0 text-sm text-text-muted">{t("video.share.codecNextStart")}</p> : null}
        <fieldset disabled={busy} className="m-0 flex flex-col gap-1 border-0 p-0">
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
                disabled={busy}
                checked={prefs.shareAudio}
                onChange={(e) => setPrefs({ shareAudio: e.target.checked })}
              />
              {t("video.share.audio")}
            </label>
            {linux && prefs.shareAudio ? (
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={busy}>
                <legend className="mb-2 text-sm font-medium">{t("voice.helper.source")}</legend>
                {(["browser", "helper"] as const).map((mode) => (
                  <label
                    key={mode}
                    className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3 hover:bg-bg-hover"
                  >
                    <input
                      type="radio"
                      name="share-audio-source"
                      checked={helperMode === (mode === "helper")}
                      onChange={() => {
                        setHelperMode(mode === "helper");
                        preferHelper(mode === "helper");
                        setError(null);
                      }}
                    />
                    <span className="text-sm">
                      <span className="block font-medium">{t(`voice.helper.mode.${mode}`)}</span>
                      <span className="text-text-muted">{t(`voice.helper.mode.${mode}.hint`)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {open && prefs.shareAudio && helperMode ? (
              <HelperAudioPicker onChange={setHelper} disabled={busy} />
            ) : (
              <p className="m-0 text-sm text-text-muted">{t("video.share.browserNote")}</p>
            )}
          </>
        )}
        {error ? <HelperErrorMessage code={error} /> : null}
        {busy && !live ? (
          <p role="status" className="m-0 text-sm text-text-muted">
            {t(prefs.shareAudio && helperMode ? "voice.helper.preparing" : "video.share.preparing")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dismiss(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || (!live && prefs.shareAudio && helperMode && !helper)}>
            {live ? t("video.share.apply") : t("video.share.continue")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
