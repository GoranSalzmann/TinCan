// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type RefObject } from "react";

/**
 * An animated image up to this size starts moving on its own; a bigger one waits for a click (23 §3). Kept as a
 * constant on purpose: it is about a member's data and battery, not a decision for the owner.
 */
export const ANIMATION_AUTOPLAY_MAX_BYTES = 8 * 1024 * 1024;
/** A video bigger than this is shown as a file card with a download link instead of a player (23 §4). */
export const VIDEO_INLINE_MAX_BYTES = 1024 * 1024 * 1024;
/** Where a video starts showing: a little in, so the first frame is not the black lead-in (browsers draw it as the poster). */
export const VIDEO_POSTER_FRAGMENT = "#t=0.1";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 83 → "1:23", 3725 → "1:02:05". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** True while the system asks for less motion; follows changes. */
export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() =>
    typeof matchMedia === "function" ? matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

let current: HTMLMediaElement | null = null;

/** Starting one player pauses the one that was playing (23 §5). Call from the `play` handler. */
export function claimPlayback(el: HTMLMediaElement): void {
  if (current && current !== el && !current.paused) current.pause();
  current = el;
}

/** Wires `claimPlayback` to an audio or video element and lets go of it when the element goes away. */
export function useExclusivePlayback(ref: RefObject<HTMLMediaElement | null>, enabled = true): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const onPlay = () => claimPlayback(el);
    el.addEventListener("play", onPlay);
    return () => {
      el.removeEventListener("play", onPlay);
      if (current === el) current = null;
    };
  }, [ref, enabled]);
}

/** Animated images the browser can move: what the server flagged and the type allows. */
export function isAnimatedImage(a: { animated: boolean; contentType: string }): boolean {
  return a.animated && /^image\/(gif|webp|png)$/.test(a.contentType);
}

/** Types the player is offered for. The server only stores these as media after checking the bytes (23 §2). */
export const isPlayableVideo = (contentType: string): boolean =>
  /^video\/(mp4|webm|quicktime)$/.test(contentType);
export const isPlayableAudio = (contentType: string): boolean =>
  /^audio\/(mp4|webm|ogg|mpeg|wav|flac)$/.test(contentType);
