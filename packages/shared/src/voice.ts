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
  /** Set by a moderator; stays until cleared, also across rejoining (11 §3). */
  serverMuted: z.boolean().optional(),
  serverDeafened: z.boolean().optional(),
});
export type VoiceParticipant = z.infer<typeof VoiceParticipantSchema>;

/** `voice` in READY and the body of GET /voice/state (07 §3.8): participants per visible voice channel. */
export const VoiceStateSnapshotSchema = z.object({
  voice: z.record(z.string(), z.array(VoiceParticipantSchema)),
});
export type VoiceStateSnapshot = z.infer<typeof VoiceStateSnapshotSchema>;

/** Body of the join call: whether this client can do frame encryption (10 §3). */
export const VoiceJoinRequestSchema = z.strictObject({ e2ee: z.boolean().optional() });

/** Key material for one epoch (10 §4.2). `key` is base64; the client keeps it in memory only. */
export const E2eeKeySchema = z.object({
  epoch: z.number().int().min(0),
  keyIndex: z.number().int().min(0).max(15),
  key: z.string(),
});
export type E2eeKey = z.infer<typeof E2eeKeySchema>;
export const E2EE_KEYRING_SIZE = 16;

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
  /** Present when the room is encrypted: the client must enable frame encryption before publishing. */
  e2ee: E2eeKeySchema.nullable().optional(),
});
export type VoiceJoinResponse = z.infer<typeof VoiceJoinResponseSchema>;

/** The owner's server-wide caps for the top video layer, in kbit/s (`GET/PATCH /admin/voice`). Advisory: see 08 §5.2. */
export const VideoLimitsSchema = z.object({ cameraMaxKbps: z.number(), screenshareMaxKbps: z.number() });
export const VideoLimitsPatchSchema = z
  .strictObject({
    cameraMaxKbps: z.number().int().min(150).max(25_000).optional(),
    screenshareMaxKbps: z.number().int().min(300).max(60_000).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "Nothing to change." });
export type VideoLimits = z.infer<typeof VideoLimitsSchema>;

export const VoiceLeaveBodySchema = z.object({ channelId: z.string().optional() });

/** `voice.state` gateway command (07 §4.6): self mute/deafen, shown to others as icons. */
export const VoiceStateArgsSchema = z.object({ muted: z.boolean(), deafened: z.boolean() });
export type VoiceStateArgs = z.infer<typeof VoiceStateArgsSchema>;

export type VoiceDisconnectReason =
  | "kicked"
  | "moved"
  | "moved_by_moderator"
  | "disconnected"
  | "joined_elsewhere"
  | "permission_lost"
  | "channel_deleted"
  | "e2ee_mode_changed";

/** `GET/PATCH /admin/voice/e2ee`: the server default that `inherit` channels follow (18 §F T17). */
export const E2eeSettingSchema = z.object({ enabled: z.boolean() });
export const E2eeSettingPatchSchema = z.strictObject({ enabled: z.boolean() });
