// SPDX-License-Identifier: AGPL-3.0-or-later
import { Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff } from "lucide-react";
import { useState } from "react";
import { useT } from "../../core/i18n/index.js";
import { leaveVoice, toggleCamera, toggleDeafen, toggleMute } from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import { stopScreenShare } from "../../core/voice/actions.js";
import { toastError } from "../../ui/toast.js";
import { ShareDialog } from "./ShareDialog.js";

const btn =
  "inline-flex size-11 items-center justify-center rounded-full border border-border-control bg-bg-sidebar hover:bg-bg-hover focus-visible:outline-2 disabled:cursor-not-allowed disabled:text-text-disabled aria-pressed:bg-bg-hover";

/** Where the browser cannot capture the screen (phones), the button is absent (W-10). */
const canCapture = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";

/** The call's control bar (W-10): mic, deafen, camera, share screen, leave. */
export function ControlBar() {
  const t = useT();
  const { muted, deafened, cameraOn, screenOn, canCamera, canScreen } = useVoice();
  const [share, setShare] = useState(false);
  return (
    <div
      role="toolbar"
      aria-label={t("video.controls")}
      className="flex justify-center gap-3 border-t border-border p-3"
    >
      <button
        type="button"
        className={btn}
        aria-pressed={muted}
        aria-label={muted ? t("voice.dock.unmute") : t("voice.dock.mute")}
        onClick={() => void toggleMute()}
      >
        {muted ? <MicOff aria-hidden="true" size={20} /> : <Mic aria-hidden="true" size={20} />}
      </button>
      <button
        type="button"
        className={btn}
        aria-pressed={deafened}
        aria-label={deafened ? t("voice.dock.undeafen") : t("voice.dock.deafen")}
        onClick={() => void toggleDeafen()}
      >
        {deafened ? (
          <HeadphoneOff aria-hidden="true" size={20} />
        ) : (
          <Headphones aria-hidden="true" size={20} />
        )}
      </button>
      <button
        type="button"
        className={btn}
        aria-pressed={cameraOn}
        disabled={!canCamera}
        title={canCamera ? undefined : t("video.noPermission.camera")}
        aria-label={cameraOn ? t("video.camera.off") : t("video.camera.on")}
        onClick={() => void toggleCamera().catch(toastError)}
      >
        {cameraOn ? <Video aria-hidden="true" size={20} /> : <VideoOff aria-hidden="true" size={20} />}
      </button>
      {canCapture() ? (
        <button
          type="button"
          className={btn}
          aria-pressed={screenOn}
          disabled={!canScreen}
          title={canScreen ? undefined : t("video.noPermission.screen")}
          aria-label={screenOn ? t("video.screen.stop") : t("video.screen.start")}
          onClick={() => (screenOn ? void stopScreenShare() : setShare(true))}
        >
          <MonitorUp aria-hidden="true" size={20} />
        </button>
      ) : null}
      <button
        type="button"
        className={`${btn} text-danger-text`}
        aria-label={t("voice.dock.leave")}
        onClick={() => void leaveVoice()}
      >
        <PhoneOff aria-hidden="true" size={20} />
      </button>
      <ShareDialog open={share} onOpenChange={setShare} />
    </div>
  );
}
