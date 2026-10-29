// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/** Wire schemas for roles, members, channels and invites (07 §3.3–3.5, 11). Bitsets are decimal strings. */

export const PermissionStringSchema = z.string().regex(/^\d{1,20}$/, "a decimal permission bitset");

/** True when the text holds no control characters (C0 and DEL). */
export const noControlChars = (s: string): boolean => {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 32 || c === 127) return false;
  }
  return true;
};

const trimmed = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(min).max(max).refine(noControlChars, "No control characters"));

export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour such as #5865f2");

// ---- roles -----------------------------------------------------------------------------------

export const RoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  position: z.number().int(),
  permissions: PermissionStringSchema,
  isDefault: z.boolean(),
  isManaged: z.boolean(),
  hoist: z.boolean(),
});
export type Role = z.infer<typeof RoleSchema>;

export const RoleCreateSchema = z.object({
  name: trimmed(1, 32),
  color: ColorSchema.nullable().optional(),
  permissions: PermissionStringSchema.optional(),
  hoist: z.boolean().optional(),
  position: z.number().int().min(1).max(10_000).optional(),
});
export type RoleCreate = z.infer<typeof RoleCreateSchema>;

export const RolePatchSchema = z.object({
  name: trimmed(1, 32).optional(),
  color: ColorSchema.nullable().optional(),
  permissions: PermissionStringSchema.optional(),
  hoist: z.boolean().optional(),
  position: z.number().int().min(1).max(10_000).optional(),
});
export type RolePatch = z.infer<typeof RolePatchSchema>;

// ---- members ---------------------------------------------------------------------------------

export const MemberSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
  statusText: z.string().nullable(),
  nickname: z.string().nullable(),
  joinedAt: z.string(),
  roleIds: z.array(z.string()),
  isOwner: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;

export const MemberPatchSchema = z.object({
  nickname: trimmed(0, 32)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .optional(),
});

// ---- channels --------------------------------------------------------------------------------

export const ChannelTypeSchema = z.enum(["text", "voice"]);

export const ChannelSettingsSchema = z.object({
  /** Seconds a member must wait between messages; 0 or absent is off. */
  slowmodeSecs: z.number().int().min(0).max(21_600).optional(),
  /** Voice channels (08 §9): maximum people at once (1–99) and the audio bitrate cap in kbit/s. */
  userLimit: z.number().int().min(1).max(99).nullish(),
  bitrateKbps: z.number().int().min(8).max(128).nullish(),
  videoAllowed: z.boolean().optional(),
  screenshareAllowed: z.boolean().optional(),
  /** Screen share cap in kbit/s for this channel; never above the server's own cap (08 §5.2). */
  maxScreenshareKbps: z.number().int().min(300).max(60_000).nullish(),
});

export type ChannelSettings = z.infer<typeof ChannelSettingsSchema>;

export const ChannelSchema = z.object({
  id: z.string(),
  categoryId: z.string().nullable(),
  type: ChannelTypeSchema,
  name: z.string(),
  topic: z.string().nullable(),
  position: z.number().int(),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
  settings: ChannelSettingsSchema,
});
export type Channel = z.infer<typeof ChannelSchema>;

export const CategorySchema = z.object({ id: z.string(), name: z.string(), position: z.number().int() });
export type Category = z.infer<typeof CategorySchema>;

export const ChannelCreateSchema = z.object({
  type: ChannelTypeSchema,
  name: trimmed(1, 64),
  topic: trimmed(0, 1024).optional(),
  categoryId: z.string().nullable().optional(),
  settings: ChannelSettingsSchema.optional(),
});
export type ChannelCreate = z.infer<typeof ChannelCreateSchema>;

export const ChannelPatchSchema = z.object({
  name: trimmed(1, 64).optional(),
  topic: trimmed(0, 1024).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  settings: ChannelSettingsSchema.optional(),
  archived: z.boolean().optional(),
});
export type ChannelPatch = z.infer<typeof ChannelPatchSchema>;

export const CategoryCreateSchema = z.object({
  name: trimmed(1, 64),
  position: z.number().int().min(0).max(10_000).optional(),
});
export const CategoryPatchSchema = z.object({
  name: trimmed(1, 64).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});

export const ChannelReorderSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        categoryId: z.string().nullable(),
        position: z.number().int().min(0).max(10_000),
      }),
    )
    .min(1)
    .max(500),
});

export const OverwriteSchema = z.object({
  targetType: z.enum(["role", "member"]),
  targetId: z.string(),
  allow: PermissionStringSchema,
  deny: PermissionStringSchema,
});
export type Overwrite = z.infer<typeof OverwriteSchema>;

export const OverwritePutSchema = z.object({ allow: PermissionStringSchema, deny: PermissionStringSchema });

/** The `GET /channels` response: what the caller may see. */
export const ChannelListSchema = z.object({
  categories: z.array(CategorySchema),
  channels: z.array(ChannelSchema),
  /** The caller's effective permissions in each visible channel (decimal strings). Cosmetic in the UI; the server decides. */
  permissions: z.record(z.string(), PermissionStringSchema),
});
export type ChannelList = z.infer<typeof ChannelListSchema>;

export const EffectivePermissionsSchema = z.object({
  permissions: PermissionStringSchema,
  steps: z.array(
    z.object({ step: z.string(), before: PermissionStringSchema, after: PermissionStringSchema }),
  ),
});

// ---- invites ---------------------------------------------------------------------------------

export const InviteSchema = z.object({
  id: z.string(),
  code: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  revokedAt: z.string().nullable(),
  defaultRoleId: z.string().nullable(),
});
export type Invite = z.infer<typeof InviteSchema>;

export const InviteCreateSchema = z.object({
  /** Seconds from now; absent means it never expires. */
  expiresInSecs: z
    .number()
    .int()
    .min(60)
    .max(365 * 86_400)
    .optional(),
  maxUses: z.number().int().min(1).max(10_000).optional(),
  defaultRoleId: z.string().optional(),
});
export type InviteCreate = z.infer<typeof InviteCreateSchema>;

export const InvitePreviewSchema = z.object({
  instanceName: z.string(),
  memberCount: z.number().int(),
});

// ---- registration and recovery (accounts) ------------------------------------------------------

export const ResetTokenResponseSchema = z.object({ code: z.string(), expiresAt: z.string() });
