// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { useVoice } from "../../core/voice/store.js";
import {
  allowedByCap,
  detectCodecSupport,
  FPS_OPTIONS,
  knownCodecSupport,
  presetsFor,
  resolutionLabel,
  resolveVideo,
  RESOLUTIONS,
  sanitizeCustom,
  type CustomVideo,
  type StreamSource,
  type VideoPrefs,
  uploadKbps,
  useVideoPrefs,
} from "../../core/voice/video.js";

/** Megabits with one decimal: "about 4 Mbit/s up, however many people watch" (W-13, W-16). */
export const mbit = (kbps: number): string => (Math.round(kbps / 100) / 10).toString();

const select = "min-h-8 rounded-md border border-border-control bg-bg-input px-2";

/**
 * Presets plus a Custom choice with resolution, frame rate and bitrate, for the camera and for a screen share. A preset
 * fills the controls; editing a control switches to Custom with the values shown. Everything is clamped to the cap the
 * server or channel gave, and the text says plainly when the setting does not fit (docs/08 §5.2).
 */
export function QualityControls({
  source,
  onChanged,
}: {
  source: StreamSource;
  /** Called with the preferences from before an edit, so a running camera can restart on the new setting. */
  onChanged?: (prev: VideoPrefs) => void;
}) {
  const t = useT();
  const prefs = useVideoPrefs((s) => s.prefs);
  const setPrefs = useVideoPrefs((s) => s.set);
  const cap = useVoice((s) => (source === "camera" ? s.caps.cameraKbps : s.caps.screenKbps));
  const [, rerender] = useState(0);
  useEffect(() => {
    void detectCodecSupport().then(() => rerender((n) => n + 1));
  }, []);

  const presetKey = source === "camera" ? "cameraPreset" : "screenPreset";
  const customKey = source === "camera" ? "cameraCustom" : "screenCustom";
  const chosen = prefs[presetKey];
  const stored = prefs[customKey];
  const r = resolveVideo(source, chosen, stored, cap, knownCodecSupport());
  if (!r) return <p className="text-sm text-danger-text">{t("video.capped.none")}</p>;
  const cur = { height: r.preset.height, fps: r.preset.fps };
  const manual = r.custom && stored.bitrateKbps !== null;

  const edit = (patch: Partial<CustomVideo>) => {
    const prev = prefs;
    const base: CustomVideo = r.custom ? stored : { ...cur, bitrateKbps: null };
    setPrefs({ [presetKey]: "custom", [customKey]: sanitizeCustom({ ...base, ...patch }, source) });
    onChanged?.(prev);
  };
  const pick = (id: string) => {
    const prev = prefs;
    setPrefs({ [presetKey]: id });
    onChanged?.(prev);
  };
  const name = `${source}-preset`;

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 font-medium">{t("video.quality")}</legend>
        {presetsFor(source).map((p) => {
          const ok = allowedByCap(p, cap);
          return (
            <label key={p.id} className={`flex items-center gap-2 ${ok ? "" : "text-text-disabled"}`}>
              <input
                type="radio"
                name={name}
                value={p.id}
                checked={!r.custom && r.preset.id === p.id}
                disabled={!ok}
                onChange={() => pick(p.id)}
              />
              {t(`video.preset.${source}.${p.id}` as MessageKey)}
              {ok ? null : <span className="text-sm">{t("video.preset.notAllowed")}</span>}
            </label>
          );
        })}
        <label className="flex items-center gap-2">
          <input type="radio" name={name} value="custom" checked={r.custom} onChange={() => edit({})} />
          {t("video.custom")}
        </label>
      </fieldset>

      <div className="grid grid-cols-[8rem_1fr] items-center gap-2">
        <label htmlFor={`${source}-res`}>{t("video.resolution")}</label>
        <select
          id={`${source}-res`}
          className={select}
          value={cur.height}
          onChange={(e) => edit({ height: Number(e.target.value) })}
        >
          {RESOLUTIONS.map((h) => (
            <option key={h} value={h}>
              {resolutionLabel(h)}
            </option>
          ))}
        </select>
        <label htmlFor={`${source}-fps`}>{t("video.fps")}</label>
        <select
          id={`${source}-fps`}
          className={select}
          value={cur.fps}
          onChange={(e) => edit({ fps: Number(e.target.value) })}
        >
          {FPS_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {t("video.fps.value", { fps: f })}
            </option>
          ))}
        </select>
        <span>{t("video.bitrate")}</span>
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${source}-bitrate`}
              checked={!manual}
              onChange={() => edit({ bitrateKbps: null })}
            />
            {t("video.bitrate.auto", { mbps: mbit(r.wantedKbps) })}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${source}-bitrate`}
              checked={manual}
              onChange={() => edit({ bitrateKbps: Math.min(r.wantedKbps, cap) })}
            />
            {t("video.bitrate.manual")}
            <input
              type="number"
              aria-label={t("video.bitrate.manualValue")}
              className={`${select} w-24`}
              min={0.1}
              step={0.1}
              disabled={!manual}
              value={manual ? +(stored.bitrateKbps! / 1000).toFixed(2) : +(r.kbps / 1000).toFixed(2)}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value) * 1000);
                if (Number.isFinite(v) && v > 0) edit({ bitrateKbps: v });
              }}
            />
            {t("video.bitrate.unit")}
          </label>
        </div>
      </div>

      {r.cappedByServer ? (
        <div role="alert" className="text-sm text-warning-text">
          <p className="m-0">{t("video.capped", { mbps: mbit(cap), wanted: mbit(r.wantedKbps) })}</p>
          {r.fitHeight ? (
            <button
              type="button"
              className="mt-1 rounded-md border border-border-control px-2 py-1 text-text hover:bg-bg-hover"
              onClick={() => edit({ height: r.fitHeight!, bitrateKbps: null })}
            >
              {t("video.capped.use", { resolution: resolutionLabel(r.fitHeight), fps: cur.fps })}
            </button>
          ) : (
            <p className="m-0">{t("video.capped.none")}</p>
          )}
        </div>
      ) : null}
      {r.lowByChoice ? (
        <p role="alert" className="m-0 text-sm text-warning-text">
          {t("video.low", { wanted: mbit(r.wantedKbps) })}
        </p>
      ) : null}
      {r.heavy ? (
        <p role="note" className="m-0 text-sm text-warning-text">
          {t("video.heavy", { mbps: Math.round(uploadKbps(r.preset) / 1000) })}
        </p>
      ) : null}
      <p className="m-0 text-sm text-text-muted">
        {t(source === "camera" ? "video.pane.upload" : "video.share.estimate", {
          mbps: mbit(uploadKbps(r.preset)),
        })}
        {r.custom ? ` ${t("video.codec", { codec: r.codec.toUpperCase() })}` : ""}
      </p>
    </div>
  );
}
