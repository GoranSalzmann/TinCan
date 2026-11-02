// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { Attachment } from "@tincan/shared";
import { fileUrl } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { fileIcon, fileKind, fileKindLabelKey } from "./fileKind.js";
import {
  ANIMATION_AUTOPLAY_MAX_BYTES,
  formatDuration,
  formatSize,
  isAnimatedImage,
  isPlayableAudio,
  isPlayableVideo,
  usePrefersReducedMotion,
  useExclusivePlayback,
  VIDEO_INLINE_MAX_BYTES,
  VIDEO_POSTER_FRAGMENT,
} from "./media.js";

/** The one place a file in a message is drawn: image, animation, video, audio, or a card with an icon and maybe a text start. */
export function AttachmentView({ a }: { a: Attachment }) {
  const t = useT();
  if (a.removed) {
    return (
      <div className="my-1 inline-block rounded-md border border-border px-3 py-2 text-sm text-text-muted">
        {t("message.fileRemoved")}
      </div>
    );
  }
  if (a.hasThumbnail && a.width && a.height) {
    return isAnimatedImage(a) ? <AnimatedImage a={a} /> : <StillImage a={a} />;
  }
  if (isPlayableVideo(a.contentType) && a.size <= VIDEO_INLINE_MAX_BYTES) return <VideoPlayer a={a} />;
  if (isPlayableAudio(a.contentType)) return <AudioPlayer a={a} />;
  return <FileCard a={a} />;
}

/** Width and height are known, so the box is reserved before the image loads (no layout shift). */
function boxOf(a: Attachment) {
  const w = Math.min(a.width!, 360);
  return { w, h: Math.round((a.height! * w) / a.width!) };
}

function StillImage({ a }: { a: Attachment }) {
  const { w, h } = boxOf(a);
  return (
    <a
      href={fileUrl(a.id, a.filename)}
      target="_blank"
      rel="noopener noreferrer"
      className="my-1 inline-block max-w-full no-underline"
    >
      <img
        src={fileUrl(a.id, a.filename, true)}
        alt={a.filename}
        width={w}
        height={h}
        loading="lazy"
        style={{ aspectRatio: `${a.width} / ${a.height}` }}
        className="max-h-80 max-w-full rounded-md bg-bg-input object-contain"
      />
      <span className="block text-xs text-text-muted">
        {a.filename} · {a.width} × {a.height}
      </span>
    </a>
  );
}

/**
 * GIF, animated WebP or APNG (23 §3). Small ones move at once; big ones, and everything when the system asks for
 * less motion, show the still thumbnail with a play button. The original is only requested once it should move.
 */
function AnimatedImage({ a }: { a: Attachment }) {
  const t = useT();
  const reduced = usePrefersReducedMotion();
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const auto = !reduced && a.size <= ANIMATION_AUTOPLAY_MAX_BYTES;
  const playing = !failed && (chosen ?? auto);
  const { w, h } = boxOf(a);
  const Icon = playing ? Pause : Play;
  return (
    <div className="my-1 inline-block max-w-full">
      <div className="relative inline-block max-w-full">
        <a
          href={fileUrl(a.id, a.filename)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block max-w-full no-underline"
        >
          <img
            src={playing ? fileUrl(a.id, a.filename) : fileUrl(a.id, a.filename, true)}
            alt={a.filename}
            width={w}
            height={h}
            loading="lazy"
            onError={() => setFailed(true)}
            style={{ aspectRatio: `${a.width} / ${a.height}` }}
            className="max-h-80 max-w-full rounded-md bg-bg-input object-contain"
          />
        </a>
        <button
          type="button"
          aria-pressed={playing}
          aria-label={
            playing ? t("file.gif.pause", { name: a.filename }) : t("file.gif.play", { name: a.filename })
          }
          onClick={() => setChosen(!playing)}
          className="elev-2 absolute start-2 bottom-2 flex min-h-8 items-center gap-1 rounded-md bg-bg-sidebar px-2 text-xs font-semibold text-text"
        >
          <Icon aria-hidden="true" size={14} />
          {t("file.gif.label")}
          {playing ? null : <span className="font-normal text-text-muted">{formatSize(a.size)}</span>}
        </button>
      </div>
      <span className="block text-xs text-text-muted">
        {a.filename} · {a.width} × {a.height}
      </span>
    </div>
  );
}

/** Native controls give keyboard and screen-reader behaviour; nothing starts by itself (23 §4). */
function VideoPlayer({ a }: { a: Attachment }) {
  const t = useT();
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState("16 / 9");
  useExclusivePlayback(ref);
  if (failed) return <FileCard a={a} note={t("file.video.unsupported")} />;
  const href = fileUrl(a.id, a.filename);
  return (
    <div className="my-1 max-w-md">
      <video
        ref={ref}
        src={`${href}${VIDEO_POSTER_FRAGMENT}`}
        controls
        preload="metadata"
        playsInline
        aria-label={t("file.video.label", { name: a.filename })}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setRatio(`${v.videoWidth} / ${v.videoHeight}`);
        }}
        onError={() => setFailed(true)}
        style={{ aspectRatio: ratio }}
        className="block max-h-80 w-full rounded-md bg-black"
      >
        <a href={href} download={a.filename}>
          {t("file.video.fallback")}
        </a>
      </video>
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span className="min-w-0 truncate">
          {a.filename} · {formatSize(a.size)}
        </span>
        <a href={href} download={a.filename} className="shrink-0 text-accent-text">
          {t("message.download")}
        </a>
      </div>
    </div>
  );
}

function AudioPlayer({ a }: { a: Attachment }) {
  const t = useT();
  const ref = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useExclusivePlayback(ref);
  if (failed) return <FileCard a={a} />;
  const href = fileUrl(a.id, a.filename);
  const Icon = fileIcon("audio");
  return (
    <div className="my-1 flex max-w-sm flex-col gap-1 rounded-md border border-border bg-bg-sidebar px-3 py-2">
      <div className="flex items-center gap-3">
        <Icon aria-hidden="true" size={24} className="shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{a.filename}</span>
          <span className="block text-xs text-text-muted">
            {t("file.kind.audio")} · {formatSize(a.size)}
            {duration !== null ? ` · ${formatDuration(duration)}` : ""}
          </span>
        </span>
        <a href={href} download={a.filename} className="text-sm text-accent-text">
          {t("message.download")}
        </a>
      </div>
      <audio
        ref={ref}
        src={href}
        controls
        preload="metadata"
        aria-label={t("file.audio.label", { name: a.filename })}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onError={() => setFailed(true)}
        className="h-10 w-full"
      />
    </div>
  );
}

/** Any other file: an icon and a visible type word, the size, and for text files the first lines (23 §6, §7). */
export function FileCard({ a, note }: { a: Attachment; note?: string }) {
  const t = useT();
  const kind = fileKind(a.contentType, a.filename);
  const Icon = fileIcon(kind);
  const href = fileUrl(a.id, a.filename);
  return (
    <div className="my-1 max-w-sm">
      <a
        href={href}
        download={a.filename}
        className="flex items-center gap-3 rounded-md border border-border bg-bg-sidebar px-3 py-2 no-underline"
      >
        <Icon aria-hidden="true" size={24} className="shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-link underline">{a.filename}</span>
          <span className="block text-xs text-text-muted">
            {t(fileKindLabelKey(kind))} · {formatSize(a.size)}
          </span>
        </span>
        <span className="text-sm text-accent-text">{t("message.download")}</span>
      </a>
      {note ? <p className="m-0 mt-1 text-xs text-text-muted">{note}</p> : null}
      {a.excerpt ? <TextExcerpt a={a} /> : null}
    </div>
  );
}

/**
 * The start of a text file. `excerpt` is plain text made by the server; it is rendered as a text node inside
 * `<pre>`, so html or xml shows as source and nothing is ever parsed or run.
 */
export function TextExcerpt({ a }: { a: Attachment }) {
  const t = useT();
  return (
    <div className="mt-1">
      <pre
        dir="auto"
        tabIndex={0}
        aria-label={t("file.excerpt.label", { name: a.filename })}
        className="m-0 max-h-40 overflow-auto rounded-md border border-border bg-bg-input p-2 font-mono text-xs break-words whitespace-pre-wrap"
      >
        {a.excerpt}
      </pre>
      {a.excerptTruncated ? <span className="text-xs text-text-muted">{t("file.excerpt.cut")}</span> : null}
    </div>
  );
}
