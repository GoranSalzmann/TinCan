// SPDX-License-Identifier: AGPL-3.0-or-later
import { Eye, EyeOff, Headphones, MicOff, Monitor } from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { VoiceParticipant } from "@tincan/shared";
import { setPlaybackVolume, unwatchStream, watchStream } from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import { streamKey } from "../../core/voice/video.js";
import { Avatar } from "../../ui/Avatar.js";
import { toastError } from "../../ui/toast.js";
import { useParticipantView, VolumeSlider } from "./Participants.js";
import { StreamSurface } from "./StreamSurface.js";

/** What a person is publishing: presence tells everyone, our own state is known at once. */
export function useSources(p: VoiceParticipant, mine: boolean): { camera: boolean; screen: boolean } {
  const cameraOn = useVoice((s) => s.cameraOn);
  const screenOn = useVoice((s) => s.screenOn);
  return {
    camera: mine ? cameraOn : p.sources.includes("camera"),
    screen: mine ? screenOn : p.sources.includes("screen_share"),
  };
}

/**
 * The tile grid is one tab stop; arrow keys move between tiles, Enter on a stream tile opens it (W-10). Tiles keep
 * their place when someone speaks.
 */
export function TileGrid({
  children,
  className = "",
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const tiles = [...(ref.current?.querySelectorAll<HTMLElement>(":scope > [data-tile]") ?? [])];
    const i = tiles.findIndex((t) => t === document.activeElement);
    if (i < 0) return;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? i + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tiles.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    tiles[Math.min(tiles.length - 1, Math.max(0, to))]?.focus();
  };
  return (
    <ul
      ref={ref}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`m-0 grid list-none gap-3 p-0 ${className}`}
    >
      {children}
    </ul>
  );
}

const frame = (speaking: boolean) =>
  `relative flex aspect-video min-h-36 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border-2 bg-bg-sidebar focus-visible:outline-2 ${speaking ? "border-success" : "border-transparent"}`;

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white">{children}</span>
  );
}

function WatchButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-text-on-accent hover:bg-accent-hover"
    >
      <Eye aria-hidden="true" size={16} />
      {label}
    </button>
  );
}

/** A person: their camera when it is on and watched (or our own preview), otherwise the avatar (W-10). */
export function PersonTile({
  p,
  channelId,
  index,
}: {
  p: VoiceParticipant;
  channelId: string;
  index: number;
}) {
  const v = useParticipantView(p);
  const src = useSources(p, v.mine);
  const key = streamKey(p.userId, "camera");
  const watching = useVoice((s) => s.watching[key] === true);
  const inCall = useVoice((s) => s.channelId === channelId && s.status === "connected");
  const showVideo = src.camera && (v.mine || (watching && inCall));
  return (
    <li
      data-tile="person"
      tabIndex={index === 0 ? 0 : -1}
      className={`group ${frame(v.speaking)}`}
      aria-label={v.speaking ? v.t("voice.speaking", { name: v.name }) : v.label}
    >
      {showVideo ? (
        <>
          <StreamSurface
            streamKey={key}
            mirror={v.mine}
            label={v.t("video.camera.of", { name: v.name })}
            className="absolute inset-0 size-full object-cover"
          />
          {!v.mine ? (
            <button
              type="button"
              aria-label={v.t("video.stopWatchingCamera", { name: v.name })}
              title={v.t("video.stopWatching")}
              onClick={() => void unwatchStream(p.userId, "camera")}
              className="absolute end-2 top-2 rounded-md bg-black/70 p-1.5 text-white opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
            >
              <EyeOff aria-hidden="true" size={16} />
            </button>
          ) : null}
        </>
      ) : (
        <>
          <Avatar name={v.name} avatarKey={v.avatarKey} size={72} />
          {src.camera && !v.mine ? (
            <WatchButton
              label={v.t("video.watchCamera")}
              onClick={() => void watchStream(channelId, p.userId, "camera").catch(toastError)}
            />
          ) : null}
        </>
      )}
      <div
        className={`flex items-center gap-2 ${showVideo ? "absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-white" : ""}`}
      >
        <bdi className="max-w-48 truncate font-medium">{v.label}</bdi>
        {v.deafened ? (
          <Headphones aria-label={v.t("voice.deafened")} size={16} />
        ) : v.muted ? (
          <MicOff aria-label={v.t("voice.muted")} size={16} />
        ) : null}
        {src.camera ? <Badge>{v.t("video.badge.camera")}</Badge> : null}
      </div>
      {v.quality === "poor" || v.quality === "lost" ? (
        <span className="text-xs text-warning-text">
          {v.t(v.quality === "lost" ? "voice.quality.lost" : "voice.quality.poor")}
        </span>
      ) : null}
      {!v.mine && !showVideo ? (
        <VolumeSlider
          userId={p.userId}
          name={v.name}
          onVolume={(vol) => void setPlaybackVolume(p.userId, vol)}
        />
      ) : null}
    </li>
  );
}

/**
 * Someone's screen share as its own tile (W-10, W-14): a placeholder until the viewer opts in. Our own share is never
 * mirrored back (it would make a tunnel); the sharing bar says what is going out.
 */
export function ScreenTile({
  p,
  channelId,
  index,
  onOpen,
}: {
  p: VoiceParticipant;
  channelId: string;
  index: number;
  onOpen: (key: string) => void;
}) {
  const v = useParticipantView(p);
  const key = streamKey(p.userId, "screen");
  const watching = useVoice((s) => s.watching[key] === true);
  const inCall = useVoice((s) => s.channelId === channelId && s.status === "connected");
  const open = () => {
    if (!v.mine && watching) onOpen(key);
  };
  const watch = () =>
    void watchStream(channelId, p.userId, "screen")
      .then(() => onOpen(key))
      .catch(toastError);
  const live = watching && inCall && !v.mine;
  return (
    <li
      data-tile="screen"
      tabIndex={index === 0 ? 0 : -1}
      className={frame(false)}
      aria-label={v.t("video.screen.of", { name: v.name })}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) open();
      }}
    >
      {live ? (
        <button
          type="button"
          onClick={open}
          aria-label={v.t("video.openStream", { name: v.name })}
          className="absolute inset-0 size-full"
        >
          <StreamSurface
            streamKey={key}
            label={v.t("video.screen.of", { name: v.name })}
            className="size-full object-contain"
          />
        </button>
      ) : (
        <>
          <Monitor aria-hidden="true" size={32} className="text-text-muted" />
          <p className="m-0 px-3 text-center text-sm">
            {v.mine ? v.t("video.sharingYou") : v.t("video.sharingOther", { name: v.name })}
          </p>
          {!v.mine ? <WatchButton label={v.t("video.watchStream")} onClick={watch} /> : null}
        </>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-black/60 px-2 py-1 text-white">
        <bdi className="min-w-0 flex-1 truncate text-sm">{v.t("video.screen.label", { name: v.label })}</bdi>
        <Badge>{v.t("video.badge.live")}</Badge>
      </div>
    </li>
  );
}
