// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-person playback volume (08 §6): a linear gain from 0 to 3 (0–300 %), kept in this browser only. Above 100 % the
 * signal can clip, so it goes through a compressor that acts as a limiter (see `limiterFor`).
 */
export const MAX_VOLUME = 3;
export const VOLUME_STEP = 0.05;
const KEY = "tincan.voice.volumes.v1";

/** Anything stored before (0–1) stays valid; garbage becomes 100 %. */
export function clampVolume(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return Math.min(MAX_VOLUME, Math.max(0, v));
}

export const isBoosted = (v: number): boolean => v > 1.0001;
export const percent = (v: number): number => Math.round(clampVolume(v) * 100);

export function loadVolumes(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): Record<string, number> {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).map(([id, v]) => [id, clampVolume(v)]));
  } catch {
    return {};
  }
}

export function saveVolumes(
  volumes: Record<string, number>,
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(volumes));
  } catch {
    // not persisted
  }
}

export const loadVolume = (userId: string): number => loadVolumes()[userId] ?? 1;

function safeStorage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Compressor settings per gain. At or below 100 % the ratio is 1, which makes the node a no-op; above it the compressor
 * limits peaks (threshold −6 dB, hard ratio) so a boosted loud voice is squashed rather than clipped. The trade-off:
 * boosted speech is slightly more compressed, and noise is raised with the voice.
 */
export function limiterFor(volume: number): {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
} {
  return isBoosted(volume)
    ? { threshold: -6, knee: 3, ratio: 20, attack: 0.003, release: 0.15 }
    : { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.15 };
}
