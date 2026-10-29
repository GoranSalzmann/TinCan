// SPDX-License-Identifier: AGPL-3.0-or-later
import { Eye, Maximize, PictureInPicture2, Volume2, VolumeX } from "lucide-react";
import { useRef, useState } from "react";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import {
  setPlaybackVolume,
  setStreamMuted,
  setStreamQuality,
  unwatchStream,
} from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import { parseStreamKey, type StreamQuality } from "../../core/voice/video.js";
import { VolumeSlider } from "./Participants.js";
import { StreamSurface } from "./StreamSurface.js";

const QUALITIES: StreamQuality[] = ["auto", "high", "low", "paused"];

/** Stream view, focus layout (W-11): one watched stream large, with its own volume and quality controls. */
export function StreamView({ streamKey }: { streamKey: string }) {
  const t = useT();
  const k = parseStreamKey(streamKey);
  const member = useCommunity((s) => (k ? s.members[k.userId] : undefined));
  const name = k ? memberName(member, k.userId) : "";
  const quality = useVoice((s) => s.streamQuality[streamKey] ?? "auto");
  const muted = useVoice((s) => s.streamMuted[streamKey] === true);
  const hasAudio = useVoice(
    (s) =>
      !!k &&
      k.source === "screen" &&
      !!s.presence[s.channelId ?? ""]
        ?.find((p) => p.userId === k.userId)
        ?.sources.includes("screen_share_audio"),
  );
  const video = useRef<HTMLVideoElement | null>(null);
  const [res, setRes] = useState<{ w: number; h: number } | null>(null);
  if (!k) return null;
  // Web pop-out is the browser's picture-in-picture; the button is hidden where it does not exist (W-17).
  const pip = typeof document !== "undefined" && document.pictureInPictureEnabled === true;

  return (
    <section
      aria-label={t("video.streamView", { name })}
      className="group relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-black"
    >
      <div className="flex items-center gap-2 bg-black/70 px-3 py-1 text-sm text-white">
        <bdi className="font-medium">
          {t(k.source === "screen" ? "video.screen.label" : "video.camera.label", { name })}
        </bdi>
        {res ? <span>{`${res.w}×${res.h}`}</span> : null}
        <span className="ms-auto inline-flex items-center gap-1">
          <Eye aria-hidden="true" size={14} />
          {t("video.youreWatching")}
        </span>
      </div>
      <StreamSurface
        streamKey={streamKey}
        videoRef={video}
        label={t(k.source === "screen" ? "video.screen.of" : "video.camera.of", { name })}
        className="min-h-0 flex-1 object-contain"
        onResolution={(w, h) => setRes({ w, h })}
      />
      <div className="flex flex-wrap items-center gap-3 bg-black/70 px-3 py-2 text-sm text-white focus-within:opacity-100">
        {hasAudio ? (
          <>
            <VolumeSlider
              userId={streamKey}
              name={name}
              label={t("video.streamVolume", { name })}
              onVolume={(v) => void setPlaybackVolume(streamKey, v)}
            />
            <button
              type="button"
              aria-pressed={muted}
              aria-label={muted ? t("video.unmuteStream") : t("video.muteStream")}
              className="rounded-md p-1.5 hover:bg-white/20"
              onClick={() => void setStreamMuted(streamKey, !muted)}
            >
              {muted ? <VolumeX aria-hidden="true" size={18} /> : <Volume2 aria-hidden="true" size={18} />}
            </button>
          </>
        ) : null}
        <label className="inline-flex items-center gap-2">
          {t("video.quality")}
          <select
            value={quality}
            onChange={(e) => void setStreamQuality(streamKey, e.target.value as StreamQuality)}
            className="rounded-md border border-border-control bg-bg-input px-2 py-1 text-text"
          >
            {QUALITIES.map((q) => (
              <option key={q} value={q}>
                {t(`video.quality.${q}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        {pip ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-white/20"
            onClick={() => void video.current?.requestPictureInPicture().catch(() => undefined)}
          >
            <PictureInPicture2 aria-hidden="true" size={16} />
            {t("video.popOut")}
          </button>
        ) : null}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-white/20"
          onClick={() => void video.current?.requestFullscreen?.().catch(() => undefined)}
        >
          <Maximize aria-hidden="true" size={16} />
          {t("video.fullscreen")}
        </button>
        <button
          type="button"
          className="ms-auto rounded-md px-3 py-1.5 hover:bg-white/20"
          onClick={() => void unwatchStream(k.userId, k.source)}
        >
          {t("video.stopWatching")}
        </button>
      </div>
    </section>
  );
}
