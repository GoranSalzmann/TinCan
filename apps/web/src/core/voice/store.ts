// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import type { VoiceParticipant } from "@tincan/shared";
import type { StreamQuality, VideoCodecName } from "./video.js";

/** What was asked of the encoder for a camera or a share (video.ts `resolveVideo`), kept for the UI. */
export interface SpecInfo {
  preset: string;
  width: number;
  height: number;
  fps: number;
  kbps: number;
  wantedKbps: number;
  uploadKbps: number;
  codec: VideoCodecName;
  cappedByServer: boolean;
}

/** What the browser really delivers and sends, from the track settings and the sender statistics (08 §5.2). */
export interface ActualInfo {
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  sentWidth: number;
  sentHeight: number;
  sentFps: number;
  /** `cpu`, `bandwidth` or `none` (RTCStats qualityLimitationReason). */
  limit: string;
}

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
  | "e2ee_unsupported"
  | "disconnected_by_moderator"
  | "moved_by_moderator"
  | "e2ee_mode_changed"
  | null;

/** Frame encryption of the call this client is in (10): off, on, or asking the server for the current key again. */
export type E2eeState = "off" | "on" | "resyncing";

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
  cameraSpec: SpecInfo | null;
  actual: { camera: ActualInfo | null; screen: ActualInfo | null };
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
    spec: SpecInfo | null;
  } | null;
  /** The one-time "the sharer can see that you're watching" notice (U15, W-14): shown for this person. */
  watchNotice: string | null;
  /** Bumped when a video track arrives or goes, so surfaces re-attach. */
  rev: number;
  e2ee: E2eeState;
  e2eeEpoch: number | null;
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
  cameraSpec: null as SpecInfo | null,
  actual: { camera: null, screen: null } as VoiceState["actual"],
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
  e2ee: "off" as E2eeState,
  e2eeEpoch: null as number | null,
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
      case "E2EE_KEY_UPDATE": {
        void import("./actions.js").then((a) => a.applyE2eeKey(d as Parameters<typeof a.applyE2eeKey>[0]));
        return;
      }
      case "VOICE_SERVER_DISCONNECT": {
        const m = d as { channelId: string; reason: string; to?: string };
        if (get().channelId !== m.channelId) return;
        // A moderator's move and a mode change put the person straight into a call again.
        if ((m.reason === "moved_by_moderator" && m.to) || m.reason === "e2ee_mode_changed") {
          const again = m.reason === "moved_by_moderator" ? m.to! : m.channelId;
          const notice: VoiceNotice =
            m.reason === "moved_by_moderator" ? "moved_by_moderator" : "e2ee_mode_changed";
          void import("./actions.js").then((a) => a.rejoinVoice(again, notice));
          return;
        }
        const notice: VoiceNotice =
          m.reason === "permission_lost"
            ? "permission_lost"
            : m.reason === "channel_deleted"
              ? "channel_deleted"
              : m.reason === "moved"
                ? null
                : m.reason === "disconnected"
                  ? "disconnected_by_moderator"
                  : "removed";
        set({ notice });
        void import("./actions.js").then((a) => a.leaveVoice({ keepNotice: true, silent: true }));
        return;
      }
    }
  },
}));
