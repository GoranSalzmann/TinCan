// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type Ref } from "react";
import { useVoice } from "../../core/voice/store.js";

/**
 * Draws one stream's video: our own camera preview, or a remote stream once the viewer opted in. It reports its size so
 * the receiver can ask for the layer that fits (08 §5.4), and the picture's own size for the header (W-11).
 */
export function StreamSurface({
  streamKey,
  mirror = false,
  className = "",
  label,
  videoRef,
  onResolution,
}: {
  streamKey: string;
  /** Own camera preview is mirrored like a mirror; others see it unmirrored. */
  mirror?: boolean;
  className?: string;
  label: string;
  videoRef?: Ref<HTMLVideoElement>;
  onResolution?: (w: number, h: number) => void;
}) {
  const el = useRef<HTMLVideoElement | null>(null);
  // Re-attach when a track arrives or goes.
  const rev = useVoice((s) => s.rev);
  const status = useVoice((s) => s.status);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const video = el.current;
    if (!video || status === "idle") return;
    let detach: (() => void) | undefined;
    let cancelled = false;
    void import("../../core/voice/manager.js").then(({ voiceManager }) => {
      if (cancelled) return;
      const track = voiceManager.videoTrack(streamKey);
      setLive(!!track);
      if (!track) return;
      track.attach(video);
      detach = () => track.detach(video);
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [streamKey, rev, status]);

  useEffect(() => {
    const video = el.current;
    if (!video || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r && r.width > 0) {
        void import("../../core/voice/manager.js").then(({ voiceManager }) =>
          voiceManager.reportSize(streamKey, r.width, r.height),
        );
      }
    });
    ro.observe(video);
    return () => ro.disconnect();
  }, [streamKey]);

  return (
    <video
      ref={(node) => {
        el.current = node;
        if (typeof videoRef === "function") videoRef(node);
        else if (videoRef) (videoRef as { current: HTMLVideoElement | null }).current = node;
      }}
      autoPlay
      playsInline
      muted
      aria-label={label}
      data-stream={streamKey}
      data-live={live ? "1" : "0"}
      onLoadedMetadata={(e) => onResolution?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
      onResize={(e) => onResolution?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
      className={`bg-black ${mirror ? "-scale-x-100" : ""} ${className}`}
    />
  );
}
