// SPDX-License-Identifier: AGPL-3.0-or-later
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, Settings, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { useCommunity } from "../../core/state/community.js";
import { joinVoice, leaveVoice, toggleDeafen, toggleMute } from "../../core/voice/actions.js";
import { useAudioPrefs } from "../../core/voice/prefs.js";
import { useVoice } from "../../core/voice/store.js";
import { Banner } from "../../ui/Banner.js";
import { toastError } from "../../ui/toast.js";

const btn = "rounded-md p-1.5 hover:bg-bg-hover focus-visible:outline-2";

/** Voice panel at the bottom of the channel list (W-06): state, mute, deafen, leave; notices when a call ends. */
export function VoiceDock() {
  const t = useT();
  const { status, channelId, notice, muted, deafened, transport, transmitting } = useVoice();
  const channelName = useCommunity((s) => s.channels.find((c) => c.id === channelId)?.name ?? "");
  const mode = useAudioPrefs((s) => s.prefs.transmitMode);
  const pttKey = useAudioPrefs((s) => s.prefs.pttKey);
  const dismiss = () => useVoice.getState().patch({ notice: null });

  const noticeTone = notice === "denoiser_downgraded" ? "warning" : "error";
  const notices = notice ? (
    <Banner tone={noticeTone}>
      <div className="flex items-start gap-2">
        <span className="flex-1">{t(`voice.notice.${notice}` as MessageKey)}</span>
        <button
          type="button"
          aria-label={t("voice.notice.dismiss")}
          onClick={dismiss}
          className="rounded p-0.5 hover:bg-bg-hover"
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>
    </Banner>
  ) : null;

  if (status === "idle") return notices ? <div className="p-2">{notices}</div> : null;

  const title =
    status === "connecting"
      ? t("voice.dock.connecting")
      : status === "reconnecting"
        ? t("voice.dock.reconnecting")
        : status === "failed"
          ? t("voice.dock.failed")
          : t("voice.dock.connected");

  return (
    <section
      aria-label={t("voice.dock")}
      className="flex flex-col gap-2 border-t border-border bg-bg-sidebar p-2"
    >
      {notices}
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" role="status">
            {title}
          </div>
          <div className="truncate text-xs text-text-muted">
            <Link
              to={channelId ? `/voice/${channelId}` : "/"}
              className="text-text-muted no-underline hover:underline"
            >
              <bdi>{channelName}</bdi>
            </Link>
            {transport
              ? ` · ${t("voice.dock.transport", { transport: t(`voice.transport.${transport}` as MessageKey) })}`
              : ""}
          </div>
          {mode === "ptt" && status === "connected" ? (
            <div className="text-xs text-text-muted">
              {transmitting ? "●" : "○"} {t("voice.dock.ptt", { key: pttKey.replace(/^Key|^Digit/, "") })}
            </div>
          ) : null}
        </div>
        {status === "failed" && channelId ? (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm hover:bg-bg-hover"
            onClick={() => void joinVoice(channelId).catch(toastError)}
          >
            {t("voice.dock.rejoin")}
          </button>
        ) : null}
        <button
          type="button"
          className={btn}
          aria-pressed={muted}
          aria-label={muted ? t("voice.dock.unmute") : t("voice.dock.mute")}
          onClick={() => void toggleMute()}
        >
          {muted ? <MicOff aria-hidden="true" size={18} /> : <Mic aria-hidden="true" size={18} />}
        </button>
        <button
          type="button"
          className={btn}
          aria-pressed={deafened}
          aria-label={deafened ? t("voice.dock.undeafen") : t("voice.dock.deafen")}
          onClick={() => void toggleDeafen()}
        >
          {deafened ? (
            <HeadphoneOff aria-hidden="true" size={18} />
          ) : (
            <Headphones aria-hidden="true" size={18} />
          )}
        </button>
        <Link to="/settings/voice" aria-label={t("voice.dock.settings")} className={btn}>
          <Settings aria-hidden="true" size={18} />
        </Link>
        <button
          type="button"
          className={`${btn} text-danger-text`}
          aria-label={t("voice.dock.leave")}
          onClick={() => void leaveVoice()}
        >
          <PhoneOff aria-hidden="true" size={18} />
        </button>
      </div>
    </section>
  );
}
