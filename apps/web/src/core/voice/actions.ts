// SPDX-License-Identifier: AGPL-3.0-or-later
import { ApiError } from "../api/client.js";
import { useVoice } from "./store.js";

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
