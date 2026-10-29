// SPDX-License-Identifier: AGPL-3.0-or-later
import { ApiError } from "../api/client.js";
import { useVoice } from "./store.js";
import type { StreamQuality, StreamSource } from "./video.js";

/**
 * Thin entry points for the UI. livekit-client and the denoiser are large, so the manager loads on the first join
 * instead of with the app (09 §3.1).
 */
async function manager() {
  const m = await import("./manager.js");
  return m.voiceManager;
}

export async function joinVoice(channelId: string): Promise<void> {
  const v = useVoice.getState();
  if (v.channelId === channelId && (v.status === "connected" || v.status === "connecting")) return;
  try {
    await (await manager()).join(channelId);
  } catch (err) {
    console.error("voice: could not join", err);
    const api = err instanceof ApiError ? err : null;
    useVoice.getState().patch({
      status: "failed",
      channelId: null,
      notice: api?.code === "UNAVAILABLE" ? "offline" : api?.code === "CONFLICT" ? "full" : "disconnected",
    });
    if (!api) throw err;
    throw err;
  }
}

export async function leaveVoice(o: { keepNotice?: boolean; silent?: boolean } = {}): Promise<void> {
  if (useVoice.getState().channelId === null && useVoice.getState().status === "idle") return;
  await (await manager()).leave(o);
}

export const toggleMute = async () => (await manager()).setMuted(!useVoice.getState().muted);
export const toggleDeafen = async () => (await manager()).setDeafened(!useVoice.getState().deafened);
export const setPlaybackVolume = async (userId: string, volume: number) =>
  (await manager()).setUserVolume(userId, volume);

// ---- video (M4) ------------------------------------------------------------------------------

export const toggleCamera = async () => (await manager()).setCamera(!useVoice.getState().cameraOn);
export const startScreenShare = async (o: { preset: string; hint: "detail" | "motion"; audio: boolean }) =>
  (await manager()).startScreenShare(o);
export const stopScreenShare = async () => (await manager()).stopScreenShare();
export const updateScreenShare = async (o: { preset: string; hint: "detail" | "motion" }) =>
  (await manager()).updateScreenShare(o);
export const setStreamQuality = async (key: string, q: StreamQuality) =>
  (await manager()).setStreamQuality(key, q);
export const setStreamMuted = async (key: string, muted: boolean) =>
  (await manager()).setStreamMuted(key, muted);
export const dismissWatchNotice = async () => (await manager()).dismissWatchNotice();
export const unwatchStream = async (userId: string, source: StreamSource) =>
  (await manager()).unwatch(userId, source);
export const applyCameraPrefs = async (prev: { deviceId: string | null; preset: string }) =>
  (await manager()).applyCameraPrefs(prev);

/** "Watch" works from outside the call too: it joins the channel first (W-14). */
export async function watchStream(channelId: string, userId: string, source: StreamSource): Promise<void> {
  const v = useVoice.getState();
  if (v.channelId !== channelId || v.status !== "connected") await joinVoice(channelId);
  (await manager()).watch(userId, source);
}
