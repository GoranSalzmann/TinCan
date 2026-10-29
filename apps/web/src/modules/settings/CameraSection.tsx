// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useT } from "../../core/i18n/index.js";
import { applyCameraPrefs } from "../../core/voice/actions.js";
import { useDevices } from "../../core/voice/devices.js";
import { useVideoPrefs } from "../../core/voice/video.js";
import { Button } from "../../ui/Button.js";
import { QualityControls } from "../voice/QualityControls.js";

/** Camera device, quality and auto-watch (W-21 video part, 08 §5.2). Changes apply live when the camera is on. */
export function CameraSection() {
  const t = useT();
  const devices = useDevices();
  const { prefs, set } = useVideoPrefs();
  const [preview, setPreview] = useState(false);
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const select = "min-h-8 rounded-md border border-border-control bg-bg-input px-2";

  const change = (patch: Partial<typeof prefs>) => {
    const prev = prefs;
    set(patch);
    void applyCameraPrefs(prev);
  };

  // The preview is a local camera stream that never leaves this tab and stops when the pane closes.
  useEffect(() => {
    if (!preview) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setFailed(false);
    navigator.mediaDevices
      .getUserMedia({
        video: prefs.cameraDeviceId ? { deviceId: { ideal: prefs.cameraDeviceId } } : true,
      })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((x) => x.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((x) => x.stop());
    };
  }, [preview, prefs.cameraDeviceId]);

  return (
    <section aria-labelledby="camera-pane" className="flex flex-col gap-3">
      <h3 id="camera-pane" className="m-0 text-lg font-semibold">
        {t("video.pane.title")}
      </h3>
      <div className="grid grid-cols-[12rem_1fr] items-center gap-3">
        <label htmlFor="cam-dev">{t("video.pane.device")}</label>
        <select
          id="cam-dev"
          className={select}
          value={prefs.cameraDeviceId ?? ""}
          onChange={(e) => change({ cameraDeviceId: e.target.value || null })}
        >
          <option value="">{t("video.pane.default")}</option>
          {devices.cameras.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>
      <QualityControls source="camera" onChanged={(prev) => void applyCameraPrefs(prev)} />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={prefs.autoWatchCameras}
          onChange={(e) => set({ autoWatchCameras: e.target.checked })}
        />
        {t("video.pane.autoWatch")}
      </label>
      <p className="m-0 text-sm text-text-muted">{t("video.pane.autoWatchHint")}</p>
      <div className="flex flex-col items-start gap-2">
        <Button variant="ghost" onClick={() => setPreview(!preview)}>
          {preview ? t("video.pane.previewOff") : t("video.pane.previewOn")}
        </Button>
        {preview ? (
          <video
            ref={video}
            autoPlay
            playsInline
            muted
            aria-label={t("video.pane.preview")}
            className="aspect-video w-72 -scale-x-100 rounded-md bg-black object-cover"
          />
        ) : null}
        {failed ? <p className="m-0 text-sm text-danger-text">{t("voice.notice.camera_denied")}</p> : null}
      </div>
    </section>
  );
}
