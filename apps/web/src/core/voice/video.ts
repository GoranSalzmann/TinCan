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
  /** One scalable encoding (VP9, AV1) instead of simulcast layers: the upload is the top bitrate alone. */
  svc?: boolean;
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
export const uploadKbps = (p: VideoPreset): number =>
  p.svc ? p.kbps : p.kbps + p.layers.reduce((a, l) => a + l.kbps, 0);

export type ContentHint = "detail" | "motion";

export interface VideoPrefs {
  cameraDeviceId: string | null;
  /** A preset id, or "custom" to use the values below. */
  cameraPreset: string;
  screenPreset: string;
  cameraCustom: CustomVideo;
  screenCustom: CustomVideo;
  contentHint: ContentHint;
  shareAudio: boolean;
  /** Off by default (design: W-10 open items). */
  autoWatchCameras: boolean;
}

const DEFAULTS: VideoPrefs = {
  cameraDeviceId: null,
  cameraPreset: "standard",
  screenPreset: "standard",
  cameraCustom: { height: 720, fps: 30, bitrateKbps: null },
  screenCustom: { height: 1080, fps: 30, bitrateKbps: null },
  contentHint: "detail",
  shareAudio: true,
  autoWatchCameras: false,
};

const KEY = "tincan.video.prefs.v1";
const NOTICE_KEY = "tincan.video.watchNotice.v1";

function load(): VideoPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<VideoPrefs>;
    // Older stored values have no custom settings: the defaults fill in, nothing else changes.
    return {
      ...DEFAULTS,
      ...raw,
      cameraCustom: sanitizeCustom(raw.cameraCustom, "camera"),
      screenCustom: sanitizeCustom(raw.screenCustom, "screen"),
    };
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

// ---- custom resolution, frame rate and bitrate ------------------------------------------------------

/** Heights offered for a custom setting; the width follows at 16:9. */
export const RESOLUTIONS = [360, 480, 720, 1080, 1440, 2160] as const;
/** Frame rates offered for a custom setting. 60 is the ceiling: above it the encoders and most displays give nothing. */
export const FPS_OPTIONS = [5, 10, 15, 24, 30, 60] as const;
const WIDTHS: Record<number, number> = { 360: 640, 480: 854, 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 };
export const widthOf = (height: number): number => WIDTHS[height] ?? Math.round((height * 16) / 9 / 2) * 2;
export const resolutionLabel = (height: number): string => (height === 2160 ? "2160p (4K)" : `${height}p`);

/** A custom setting. `bitrateKbps: null` is "Auto for this resolution and frame rate". */
export interface CustomVideo {
  height: number;
  fps: number;
  bitrateKbps: number | null;
}

export const DEFAULT_CUSTOM: Record<StreamSource, CustomVideo> = {
  camera: { height: 720, fps: 30, bitrateKbps: null },
  screen: { height: 1080, fps: 30, bitrateKbps: null },
};

/** Stored values may come from an older version or from a hand edit: anything outside the offered lists is replaced. */
export function sanitizeCustom(v: unknown, source: StreamSource): CustomVideo {
  const d = DEFAULT_CUSTOM[source];
  const o = (v && typeof v === "object" ? v : {}) as Partial<CustomVideo>;
  const kbps = o.bitrateKbps;
  return {
    height: (RESOLUTIONS as readonly number[]).includes(o.height as number) ? (o.height as number) : d.height,
    fps: (FPS_OPTIONS as readonly number[]).includes(o.fps as number) ? (o.fps as number) : d.fps,
    bitrateKbps: typeof kbps === "number" && Number.isFinite(kbps) && kbps >= 100 ? Math.round(kbps) : null,
  };
}

export type VideoCodecName = "vp8" | "vp9" | "av1";
/** Bits needed relative to VP8 for the same quality (rule of thumb from the encoders' own guidance, not measured here). */
const CODEC_FACTOR: Record<VideoCodecName, number> = { vp8: 1, vp9: 0.75, av1: 0.65 };

/**
 * The bitrate a resolution and frame rate want, in kbit/s: about 0.06 bit per pixel at 30 fps, a little less per pixel as
 * the rate goes up (consecutive frames are more alike). It lands on the presets: 720p30 camera 1.66 Mbit/s (preset 1.7),
 * 1080p30 3.7 (3.5), 1080p60 6.05 (6.0), 720p15 1.0 (1.0). Rounded to 50.
 */
export function autoKbps(width: number, height: number, fps: number, codec: VideoCodecName = "vp8"): number {
  const bpp = 0.06 * Math.pow(30 / fps, 0.3);
  return Math.max(100, Math.round((width * height * fps * bpp * CODEC_FACTOR[codec]) / 1000 / 50) * 50);
}

export interface CodecSupport {
  vp9: boolean;
  /** AV1 that the browser says it can encode in hardware; software AV1 at these sizes is not offered. */
  av1Hardware: boolean;
}

/**
 * The codec for a setting. Up to 1080p30 VP8 stays (it is what the presets use, and every browser decodes it). Above that
 * VP9 is about a quarter cheaper per picture, and AV1 more so but only where the machine encodes it in hardware; a
 * VP8 backup is published when a viewer cannot decode the chosen codec (the SDK's default policy).
 */
export function pickCodec(height: number, fps: number, support: CodecSupport): VideoCodecName {
  if (height <= 1080 && fps <= 30) return "vp8";
  if (support.av1Hardware) return "av1";
  if (support.vp9) return "vp9";
  return "vp8";
}

type Layer = VideoPreset["layers"][number];

/**
 * Lower simulcast layers for a custom setting: half and quarter size at a reduced rate, each well under the one above.
 * Cameras get them from 360p up (tiles are small); a screen share gets a half layer from 1080p and a quarter layer at 4K.
 */
export function deriveLayers(
  source: StreamSource,
  width: number,
  height: number,
  fps: number,
  topKbps: number,
  codec: VideoCodecName = "vp8",
): Layer[] {
  const out: Layer[] = [];
  const half = source === "camera" ? height / 2 >= 180 : height >= 1080;
  const quarter = source === "camera" ? height / 4 >= 180 : height >= 2160;
  const add = (div: number, rate: number, share: number) => {
    const w = Math.round(width / div / 2) * 2;
    const h = Math.round(height / div / 2) * 2;
    const f = Math.min(fps, rate);
    out.push({
      width: w,
      height: h,
      fps: f,
      kbps: Math.max(80, Math.min(autoKbps(w, h, f, codec), Math.round(topKbps * share))),
    });
  };
  if (half) add(2, 30, 0.5);
  if (quarter) add(4, 15, 0.25);
  return out.reverse(); // the SDK wants them from the smallest
}

export interface Resolved {
  preset: VideoPreset;
  codec: VideoCodecName;
  custom: boolean;
  /** What this resolution and frame rate want. */
  wantedKbps: number;
  /** What will be used: the choice, never above the cap. */
  kbps: number;
  /** Below what it wants because of the server's or the channel's cap. */
  cappedByServer: boolean;
  /** Below what it wants because the person chose a low value. */
  lowByChoice: boolean;
  /** The highest height that fits the cap at this frame rate, when the chosen one does not. */
  fitHeight: number | null;
  /** A setting that needs a fast computer and a fast uplink, or fast decoding for viewers. */
  heavy: boolean;
}

/**
 * One resolved setting, from a preset id or from `custom`, clamped to the cap. Presets keep their fixed values and their
 * existing fall-back to a smaller preset when the cap is below them; a custom setting keeps its resolution and frame rate
 * and takes the cap as its bitrate, so the person sees the trade instead of a silent change.
 */
export function resolveVideo(
  source: StreamSource,
  id: string,
  custom: CustomVideo,
  capKbps: number,
  support: CodecSupport = { vp9: false, av1Hardware: false },
): Resolved | null {
  if (id !== "custom") {
    const preset = resolvePreset(source, id, capKbps);
    if (!preset) return null;
    return {
      preset,
      codec: "vp8",
      custom: false,
      wantedKbps: preset.kbps,
      kbps: preset.kbps,
      cappedByServer: false,
      lowByChoice: false,
      fitHeight: null,
      heavy: false,
    };
  }
  const c = sanitizeCustom(custom, source);
  const width = widthOf(c.height);
  const codec = pickCodec(c.height, c.fps, support);
  const wantedKbps = autoKbps(width, c.height, c.fps, codec);
  const chosen = c.bitrateKbps ?? wantedKbps;
  const kbps = Math.max(100, Math.min(chosen, capKbps));
  const cappedByServer = chosen > capKbps && capKbps < wantedKbps * 0.9;
  const lowByChoice = !cappedByServer && kbps < wantedKbps * 0.9;
  let fitHeight: number | null = null;
  if (cappedByServer) {
    for (const h of [...RESOLUTIONS].reverse()) {
      if (h < c.height && autoKbps(widthOf(h), h, c.fps, pickCodec(h, c.fps, support)) <= capKbps) {
        fitHeight = h;
        break;
      }
    }
  }
  const svc = codec !== "vp8";
  const layers = svc ? [] : deriveLayers(source, width, c.height, c.fps, kbps, codec);
  const preset: VideoPreset = { id: "custom", width, height: c.height, fps: c.fps, kbps, layers };
  if (svc) preset.svc = true;
  return {
    preset,
    codec,
    custom: true,
    wantedKbps,
    kbps,
    cappedByServer,
    lowByChoice,
    fitHeight,
    heavy: c.height >= 2160 || c.fps >= 60 || kbps > 25_000,
  };
}

/** Looks at what this browser can encode. Cached; the answer does not change during a visit. */
let support: Promise<CodecSupport> | null = null;
let known: CodecSupport = { vp9: false, av1Hardware: false };
export const knownCodecSupport = (): CodecSupport => known;
export function detectCodecSupport(): Promise<CodecSupport> {
  support ??= (async () => {
    const out: CodecSupport = { vp9: false, av1Hardware: false };
    try {
      const caps = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
      out.vp9 = caps.some((c) => /vp9/i.test(c.mimeType));
      const hasAv1 = caps.some((c) => /av1/i.test(c.mimeType));
      if (hasAv1 && navigator.mediaCapabilities?.encodingInfo) {
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: "webrtc",
          video: { contentType: "video/AV1", width: 3840, height: 2160, framerate: 30, bitrate: 15_000_000 },
        });
        out.av1Hardware = info.supported && info.powerEfficient;
      }
    } catch {
      // unknown: stay on VP8, which works everywhere
    }
    known = out;
    return out;
  })();
  return support;
}

try {
  if (localStorage.getItem("tincan.debug"))
    (window as unknown as { __tincanVideoPrefs?: typeof useVideoPrefs }).__tincanVideoPrefs = useVideoPrefs;
} catch {
  // no storage: no hook
}
