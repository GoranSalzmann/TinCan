// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/** The LiveKit room that carries a voice channel (08 §2). */
export const voiceRoomName = (channelId: string): string => `vc_${channelId}`;

/** Inverse of `voiceRoomName`; null for rooms that are not ours. */
export function channelIdOfRoom(room: string): string | null {
  return room.startsWith("vc_") && room.length > 3 ? room.slice(3) : null;
}

/** Sources a participant can publish (08 §2, §8). */
export const VOICE_SOURCES = ["microphone", "camera", "screen_share", "screen_share_audio"] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];

export const VoiceParticipantSchema = z.object({
  userId: z.string(),
  joinedAt: z.string(),
  /** Published sources right now, from LiveKit track webhooks. */
  sources: z.array(z.enum(VOICE_SOURCES)),
  muted: z.boolean(),
  deafened: z.boolean(),
});
export type VoiceParticipant = z.infer<typeof VoiceParticipantSchema>;

/** `voice` in READY and the body of GET /voice/state (07 §3.8): participants per visible voice channel. */
export const VoiceStateSnapshotSchema = z.object({
  voice: z.record(z.string(), z.array(VoiceParticipantSchema)),
});
export type VoiceStateSnapshot = z.infer<typeof VoiceStateSnapshotSchema>;

export const VoiceJoinResponseSchema = z.object({
  /** Public WebSocket URL of the signalling endpoint (`wss://host/livekit`). */
  url: z.string(),
  token: z.string(),
  expiresAt: z.string(),
  roomName: z.string(),
  /** Encoding defaults for the client (08 §4.1, §6). */
  publishDefaults: z.object({
    audioBitrateKbps: z.number().int(),
    dtx: z.boolean(),
    red: z.boolean(),
    /** Sources this user may publish; the client greys out the others. */
    sources: z.array(z.enum(VOICE_SOURCES)),
    /** Caps for the top video layer in kbit/s; the client offers only presets within them (08 §5.2). */
    video: z.object({
      cameraMaxKbps: z.number().int(),
      screenshareMaxKbps: z.number().int(),
    }),
  }),
  userLimit: z.number().int(),
});
export type VoiceJoinResponse = z.infer<typeof VoiceJoinResponseSchema>;

export const VoiceLeaveBodySchema = z.object({ channelId: z.string().optional() });

/** `voice.state` gateway command (07 §4.6): self mute/deafen, shown to others as icons. */
export const VoiceStateArgsSchema = z.object({ muted: z.boolean(), deafened: z.boolean() });
export type VoiceStateArgs = z.infer<typeof VoiceStateArgsSchema>;

export type VoiceDisconnectReason =
  "kicked" | "moved" | "joined_elsewhere" | "permission_lost" | "channel_deleted";
