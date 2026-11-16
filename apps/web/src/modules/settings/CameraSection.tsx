// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useT } from "../../core/i18n/index.js";
import { applyCameraPrefs } from "../../core/voice/actions.js";
import { useDevices } from "../../core/voice/devices.js";
import { useVideoPrefs } from "../../core/voice/video.js";
import { Button } from "../../ui/Button.js";
import { selectClass } from "../../ui/Controls.js";
import { QualityControls } from "../voice/QualityControls.js";
import { Panel, Row, SettingsSection, SwitchRow } from "./layout.js";

/** Camera device, quality and auto-watch (W-21 video part, 08 §5.2). Changes apply live when the camera is on. */
export function CameraSection() {
  const t = useT();
  const devices = useDevices();
  const { prefs, set } = useVideoPrefs();
  const [preview, setPreview] = useState(false);
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

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
    <SettingsSection title={t("video.pane.title")} description={t("video.pane.description")}>
      <Panel label={t("video.pane.title")}>
        <Row
          label={t("video.pane.device")}
          htmlFor="cam-dev"
          control={
            <select
              id="cam-dev"
              className={`${selectClass} w-64`}
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
          }
        />
        <div className="px-5 py-4">
          <QualityControls source="camera" onChanged={(prev) => void applyCameraPrefs(prev)} />
        </div>
        <SwitchRow
          label={t("video.pane.autoWatch")}
          description={t("video.pane.autoWatchHint")}
          checked={prefs.autoWatchCameras}
          onChange={(v) => set({ autoWatchCameras: v })}
        />
        <Row
          label={t("video.pane.preview")}
          control={
            <Button variant="ghost" onClick={() => setPreview(!preview)}>
              {preview ? t("video.pane.previewOff") : t("video.pane.previewOn")}
            </Button>
          }
        >
          {preview ? (
            <video
              ref={video}
              autoPlay
              playsInline
              muted
              aria-label={t("video.pane.preview")}
              className="aspect-video w-full max-w-md -scale-x-100 rounded-md bg-bg-video object-cover"
            />
          ) : null}
          {failed ? <p className="m-0 text-sm text-danger-text">{t("voice.notice.camera_denied")}</p> : null}
        </Row>
      </Panel>
    </SettingsSection>
  );
}
