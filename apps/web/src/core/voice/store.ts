// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import type { VoiceParticipant } from "@tincan/shared";
import type { StreamQuality } from "./video.js";

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting" | "failed";
export type Quality = "excellent" | "good" | "poor" | "lost" | "unknown";

/** Why the last call ended or could not start; the UI maps it to a plain-language message (08 §4.4, §11). */
export type VoiceNotice =
  | "joined_elsewhere"
  | "removed"
  | "permission_lost"
  | "channel_deleted"
  | "offline"
  | "full"
  | "mic_denied"
  | "mic_missing"
  | "camera_denied"
  | "camera_missing"
  | "camera_failed"
  | "screen_failed"
  | "denoiser_downgraded"
  | "disconnected"
  | null;

interface VoiceState {
  /** Who is in which voice channel, as the server tells it (READY, VOICE_STATE_UPDATE). */
  presence: Record<string, VoiceParticipant[]>;
  status: VoiceStatus;
  channelId: string | null;
  notice: VoiceNotice;
  muted: boolean;
  deafened: boolean;
  /** Push to talk: true while the key is held (or the release delay runs). */
  transmitting: boolean;
  speaking: Record<string, boolean>;
  quality: Record<string, Quality>;
  localLevel: number;
  /** The transport the media ended up on, for the status line and diagnostics (08 §10). */
  transport: "udp" | "tcp" | "relay" | null;
  /** Video (M4). Stream keys are `userId:camera` and `userId:screen` (video.ts). */
  cameraOn: boolean;
  screenOn: boolean;
  /** What the server lets this person publish right now; follows permission changes mid-call. */
  canCamera: boolean;
  canScreen: boolean;
  /** Streams this client receives; nothing is received until the person opts in (R-041). */
  watching: Record<string, true>;
  streamQuality: Record<string, StreamQuality>;
  streamMuted: Record<string, boolean>;
  /** Who watches what, reported by the viewers' own clients (08 §5.6). */
  viewers: Record<string, string[]>;
  /** Server caps for the top layer in kbit/s (08 §5.2). */
  caps: { cameraKbps: number; screenKbps: number };
  /** What this person is sharing right now, for the sharing bar (W-13). */
  share: {
    preset: string;
    hint: "detail" | "motion";
    audio: boolean;
    surface: "monitor" | "window" | "browser" | null;
  } | null;
  /** The one-time "the sharer can see that you're watching" notice (U15, W-14): shown for this person. */
  watchNotice: string | null;
  /** Bumped when a video track arrives or goes, so surfaces re-attach. */
  rev: number;
  apply: (t: string, d: unknown) => void;
  patch: (p: Partial<VoiceState>) => void;
  reset: () => void;
}

const initial = {
  presence: {} as Record<string, VoiceParticipant[]>,
  status: "idle" as VoiceStatus,
  channelId: null as string | null,
  notice: null as VoiceNotice,
  muted: false,
  deafened: false,
  transmitting: false,
  speaking: {} as Record<string, boolean>,
  quality: {} as Record<string, Quality>,
  localLevel: 0,
  transport: null as "udp" | "tcp" | "relay" | null,
  cameraOn: false,
  screenOn: false,
  canCamera: false,
  canScreen: false,
  watching: {} as Record<string, true>,
  streamQuality: {} as Record<string, StreamQuality>,
  streamMuted: {} as Record<string, boolean>,
  viewers: {} as Record<string, string[]>,
  caps: { cameraKbps: 1700, screenKbps: 6000 },
  share: null as VoiceState["share"],
  watchNotice: null as string | null,
  rev: 0,
};

/** Applies one VOICE_STATE_UPDATE to the presence map. Idempotent (07 §5). */
export function applyVoiceUpdate(
  presence: Record<string, VoiceParticipant[]>,
  d: { channelId: string; userId: string; joined: boolean; participant?: VoiceParticipant },
): Record<string, VoiceParticipant[]> {
  const rest = (presence[d.channelId] ?? []).filter((p) => p.userId !== d.userId);
  const next = d.joined && d.participant ? [...rest, d.participant] : rest;
  const out = { ...presence };
  // A person is in one room at a time: joining here removes them from any other room.
  if (d.joined) {
    for (const [id, list] of Object.entries(out)) {
      if (id !== d.channelId && list.some((p) => p.userId === d.userId)) {
        out[id] = list.filter((p) => p.userId !== d.userId);
      }
    }
  }
  if (next.length === 0) delete out[d.channelId];
  else out[d.channelId] = next;
  return out;
}

export const useVoice = create<VoiceState>((set, get) => ({
  ...initial,
  patch: (p) => set(p),
  reset: () => set({ ...initial }),
  apply(t, d) {
    switch (t) {
      case "READY": {
        // After a non-resumable reconnect, cached voice presence is untrusted: replace it (07 §4.5).
        set({ presence: (d as { voice?: Record<string, VoiceParticipant[]> }).voice ?? {} });
        return;
      }
      case "VOICE_STATE_UPDATE":
        set({ presence: applyVoiceUpdate(get().presence, d as Parameters<typeof applyVoiceUpdate>[1]) });
        return;
      case "VOICE_SERVER_DISCONNECT": {
        const reason = (d as { reason: string }).reason;
        const notice: VoiceNotice =
          reason === "permission_lost"
            ? "permission_lost"
            : reason === "channel_deleted"
              ? "channel_deleted"
              : reason === "moved"
                ? null
                : "removed";
        if (get().channelId !== (d as { channelId: string }).channelId) return;
        set({ notice });
        void import("./actions.js").then((a) => a.leaveVoice({ keepNotice: true, silent: true }));
        return;
      }
    }
  },
}));
