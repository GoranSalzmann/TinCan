// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";

/**
 * Camera and screen share settings (08 §5.2, W-13, W-16): presets within the server's caps, the device choice, and the
 * pure helpers the manager and the dialogs share. Per-browser, kept in localStorage.
 */
export type StreamSource = "camera" | "screen";

export interface VideoPreset {
  id: string;
  width: number;
  height: number;
  fps: number;
  /** Top layer cap in kbit/s. */
  kbps: number;
  /** Lower simulcast layers below the top one (08 §5.2). */
  layers: { width: number; height: number; kbps: number; fps: number }[];
}

/** Camera: 720p30 is the default, with three layers because tiles are often small (08 §5.2). */
export const CAMERA_PRESETS: VideoPreset[] = [
  {
    id: "low",
    width: 640,
    height: 360,
    fps: 30,
    kbps: 600,
    layers: [{ width: 320, height: 180, kbps: 150, fps: 15 }],
  },
  {
    id: "standard",
    width: 1280,
    height: 720,
    fps: 30,
    kbps: 1700,
    layers: [
      { width: 640, height: 360, kbps: 500, fps: 30 },
      { width: 320, height: 180, kbps: 150, fps: 15 },
    ],
  },
  {
    id: "high",
    width: 1920,
    height: 1080,
    fps: 30,
    kbps: 3200,
    layers: [
      { width: 960, height: 540, kbps: 900, fps: 30 },
      { width: 480, height: 270, kbps: 250, fps: 15 },
    ],
  },
];

/** Screen: low upload has one layer, the others a 540p layer next to the top one. */
export const SCREEN_PRESETS: VideoPreset[] = [
  { id: "low", width: 1280, height: 720, fps: 15, kbps: 1000, layers: [] },
  {
    id: "standard",
    width: 1920,
    height: 1080,
    fps: 30,
    kbps: 3500,
    layers: [{ width: 960, height: 540, kbps: 600, fps: 15 }],
  },
  {
    id: "smooth",
    width: 1920,
    height: 1080,
    fps: 60,
    kbps: 6000,
    layers: [{ width: 960, height: 540, kbps: 800, fps: 30 }],
  },
];

export const presetsFor = (source: StreamSource): VideoPreset[] =>
  source === "camera" ? CAMERA_PRESETS : SCREEN_PRESETS;

/** A preset is offered only when its top layer fits the server's cap (08 §5.2). */
export const allowedByCap = (p: VideoPreset, capKbps: number): boolean => p.kbps <= capKbps;

/** The wanted preset, or the best allowed one at or below it; null when even the lowest is above the cap. */
export function resolvePreset(source: StreamSource, wanted: string, capKbps: number): VideoPreset | null {
  const all = presetsFor(source);
  const i = Math.max(
    0,
    all.findIndex((p) => p.id === wanted),
  );
  for (let k = i; k >= 0; k--) if (allowedByCap(all[k]!, capKbps)) return all[k]!;
  return null;
}

/**
 * What the publisher uploads at most: every layer that is in demand, however many people watch (G4, 08 §5.1). With
 * dynacast the real number is lower when nobody wants the top layer.
 */
export const uploadKbps = (p: VideoPreset): number => p.kbps + p.layers.reduce((a, l) => a + l.kbps, 0);

export type ContentHint = "detail" | "motion";

export interface VideoPrefs {
  cameraDeviceId: string | null;
  cameraPreset: string;
  screenPreset: string;
  contentHint: ContentHint;
  shareAudio: boolean;
  /** Off by default (design: W-10 open items). */
  autoWatchCameras: boolean;
}

const DEFAULTS: VideoPrefs = {
  cameraDeviceId: null,
  cameraPreset: "standard",
  screenPreset: "standard",
  contentHint: "detail",
  shareAudio: true,
  autoWatchCameras: false,
};

const KEY = "tincan.video.prefs.v1";
const NOTICE_KEY = "tincan.video.watchNotice.v1";

function load(): VideoPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<VideoPrefs>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return DEFAULTS;
  }
}

export const useVideoPrefs = create<{ prefs: VideoPrefs; set: (p: Partial<VideoPrefs>) => void }>(
  (set, get) => ({
    prefs: load(),
    set(p) {
      const prefs = { ...get().prefs, ...p };
      set({ prefs });
      try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
      } catch {
        // not persisted
      }
    },
  }),
);

/** "The sharer can see that you are watching" is shown once per device (U15, W-14). */
export function watchNoticeSeen(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    return true;
  }
}
export function markWatchNoticeSeen(): void {
  try {
    localStorage.setItem(NOTICE_KEY, "1");
  } catch {
    // shown again next time
  }
}

// ---- stream keys and the viewer list (08 §5.6) ----------------------------------------------------

export const streamKey = (userId: string, source: StreamSource): string => `${userId}:${source}`;

export function parseStreamKey(key: string): { userId: string; source: StreamSource } | null {
  const i = key.lastIndexOf(":");
  const source = key.slice(i + 1);
  if (i <= 0 || (source !== "camera" && source !== "screen")) return null;
  return { userId: key.slice(0, i), source };
}

/** The attribute a viewer publishes: the streams it watches, as a comma separated list of stream keys. */
export const WATCHING_ATTRIBUTE = "watching";
export const encodeWatching = (keys: Iterable<string>): string => [...keys].sort().join(",");
export const decodeWatching = (value: string | undefined): string[] =>
  (value ?? "").split(",").filter((k) => parseStreamKey(k) !== null);

/** Who watches which stream, from the attributes of everyone in the room. Client-reported and best effort. */
export function viewersFrom(
  attributes: Iterable<{ identity: string; attributes: Record<string, string> }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of attributes) {
    for (const key of decodeWatching(p.attributes[WATCHING_ATTRIBUTE])) {
      (out[key] ??= []).push(p.identity);
    }
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

export type StreamQuality = "auto" | "high" | "low" | "paused";
