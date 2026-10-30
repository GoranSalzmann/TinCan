// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { noControlChars } from "./community.js";

/** Wire schemas for moderation and the audit log (11 §3, 06 §3.10). */

const reason = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().max(512).refine(noControlChars, "No control characters"))
  .optional();

export const KickRequestSchema = z.strictObject({ reason });
export type KickRequest = z.infer<typeof KickRequestSchema>;

/** `purgeDays` deletes the person's messages of the last N days (0 to 7) when they are banned (11 §3). */
export const BanRequestSchema = z.strictObject({
  reason,
  purgeDays: z.number().int().min(0).max(7).default(0),
});
export type BanRequest = z.infer<typeof BanRequestSchema>;

export const MAX_TIMEOUT_SECS = 28 * 86_400;
/** `durationSecs: null` ends a timeout early. One minute to 28 days (11 §3). */
export const TimeoutRequestSchema = z.strictObject({
  durationSecs: z.number().int().min(60).max(MAX_TIMEOUT_SECS).nullable(),
  reason,
});
export type TimeoutRequest = z.infer<typeof TimeoutRequestSchema>;

/** Server mute and deafen stay on until a moderator clears them, also across leaving and rejoining. */
export const VoiceModRequestSchema = z
  .strictObject({ muted: z.boolean().optional(), deafened: z.boolean().optional(), reason })
  .refine((o) => o.muted !== undefined || o.deafened !== undefined, { message: "Nothing to change." });
export type VoiceModRequest = z.infer<typeof VoiceModRequestSchema>;

export const VoiceMoveRequestSchema = z.strictObject({ channelId: z.string().min(1).max(64), reason });
export type VoiceMoveRequest = z.infer<typeof VoiceMoveRequestSchema>;

export const VoiceDisconnectRequestSchema = z.strictObject({ reason });

export const BanSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  reason: z.string().nullable(),
  bannedBy: z.string().nullable(),
  bannedAt: z.string(),
});
export type Ban = z.infer<typeof BanSchema>;

export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actorId: z.string().nullable(),
  /** Dotted action name, for example `member.kick` or `role.update`. */
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  reason: z.string().nullable(),
  /** Action-specific facts (never secrets, never message text). */
  data: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditListQuerySchema = z.object({
  before: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().max(64).optional(),
  actorId: z.string().max(64).optional(),
  targetId: z.string().max(64).optional(),
});
export const AuditListSchema = z.object({
  items: z.array(AuditEntrySchema),
  /** Pass as `before` for the next page; null at the end. */
  next: z.string().nullable(),
});
export type AuditList = z.infer<typeof AuditListSchema>;
