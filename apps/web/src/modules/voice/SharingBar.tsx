// SPDX-License-Identifier: AGPL-3.0-or-later
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { formatList, useLocale, useT, type MessageKey } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import { stopScreenShare, toggleCamera } from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import { streamKey } from "../../core/voice/video.js";
import { Button } from "../../ui/Button.js";
import { ShareDialog, mbps } from "./ShareDialog.js";

/**
 * The bar at the top of the main column while you share or have your camera on (W-13): what goes out, who watches
 * (client-reported, so possibly incomplete, 08 §5.6), and the upload estimate, which does not depend on viewers.
 */
export function SharingBar() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const self = useSession((s) => s.user?.id ?? "");
  const screenOn = useVoice((s) => s.screenOn);
  const cameraOn = useVoice((s) => s.cameraOn);
  const share = useVoice((s) => s.share);
  const cameraSpec = useVoice((s) => s.cameraSpec);
  const actual = useVoice((s) => s.actual);
  const viewers = useVoice((s) => s.viewers);
  const members = useCommunity((s) => s.members);
  const [open, setOpen] = useState(false);
  const [change, setChange] = useState(false);
  if (!screenOn && !cameraOn) return null;

  const names = (key: string) =>
    (viewers[key] ?? []).filter((id) => id !== self).map((id) => memberName(members[id], id));
  const watchers = [...new Set([...names(streamKey(self, "screen")), ...names(streamKey(self, "camera"))])];
  const upload =
    (screenOn ? (share?.spec?.uploadKbps ?? 0) : 0) + (cameraOn ? (cameraSpec?.uploadKbps ?? 0) : 0);
  const summary =
    watchers.length === 0
      ? t("video.bar.nobody")
      : watchers.length <= 3
        ? t("video.bar.watching", { names: formatList(locale, watchers), count: watchers.length })
        : t("video.bar.watchingMany", {
            names: formatList(locale, [
              ...watchers.slice(0, 2),
              t("video.bar.others", { count: watchers.length - 2 }),
            ]),
          });

  return (
    <section
      aria-label={t("video.bar")}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-bg-sidebar px-4 py-2 text-sm"
    >
      <span className="rounded bg-danger px-1.5 py-0.5 text-xs font-bold text-text-on-danger">
        {t("video.badge.live")}
      </span>
      <span>
        {screenOn
          ? t("video.bar.sharing", { what: t(`video.surface.${share?.surface ?? "unknown"}` as MessageKey) })
          : t("video.bar.camera")}
      </span>
      <span className="relative">
        <button
          type="button"
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-md px-1 hover:bg-bg-hover"
          onClick={() => setOpen(!open)}
        >
          <span aria-live="polite">{summary}</span>
          <ChevronDown aria-hidden="true" size={14} />
        </button>
        {open ? (
          <div className="elev-2 absolute start-0 top-full z-20 mt-1 w-64 rounded-md bg-bg-elevated p-3">
            <h2 className="m-0 mb-1 text-sm font-semibold">
              {t("video.bar.list", { count: watchers.length })}
            </h2>
            <ul className="m-0 list-none p-0">
              {watchers.map((n) => (
                <li key={n}>
                  <bdi>{n}</bdi>
                </li>
              ))}
            </ul>
            <p className="m-0 mt-2 border-t border-border pt-2 text-xs text-text-muted">
              {t("video.bar.disclaimer")}
            </p>
          </div>
        ) : null}
      </span>
      <span className="text-text-muted">{t("video.bar.upload", { mbps: mbps(upload) })}</span>
      <span className="ms-auto flex gap-2">
        {screenOn ? (
          <Button variant="ghost" onClick={() => setChange(true)}>
            {t("video.bar.change")}
          </Button>
        ) : null}
        {screenOn ? (
          <Button variant="danger" onClick={() => void stopScreenShare()}>
            {t("video.bar.stop")}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => void toggleCamera()}>
            {t("video.bar.cameraOff")}
          </Button>
        )}
      </span>
      <div className="flex basis-full flex-col gap-0.5 text-xs text-text-muted" data-testid="video-readout">
        {(
          [
            ["screen", screenOn ? share?.spec : null, actual.screen],
            ["camera", cameraOn ? cameraSpec : null, actual.camera],
          ] as const
        ).map(([kind, spec, a]) =>
          spec ? (
            <p key={kind} className="m-0">
              <strong>{t(`video.bar.${kind}.label` as MessageKey)}:</strong>{" "}
              {t("video.bar.requested", {
                width: spec.width,
                height: spec.height,
                fps: spec.fps,
                mbps: mbps(spec.kbps),
                codec: spec.codec.toUpperCase(),
              })}
              {a
                ? `. ${t(a.sentFps > 0 ? "video.bar.actual" : "video.bar.idle", { cw: a.captureWidth, ch: a.captureHeight, cf: a.captureFps, sw: a.sentWidth, sh: a.sentHeight, sf: a.sentFps })}`
                : ""}
              {a &&
              (a.captureHeight < spec.height * 0.95 || (a.captureFps > 0 && a.captureFps < spec.fps * 0.8))
                ? ` ${t("video.bar.less")}`
                : ""}
              {a && (a.limit === "cpu" || a.limit === "bandwidth")
                ? ` ${t(`video.bar.limit.${a.limit}` as MessageKey)}`
                : ""}
            </p>
          ) : null,
        )}
      </div>
      <ShareDialog open={change} onOpenChange={setChange} />
    </section>
  );
}
