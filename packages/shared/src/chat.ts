// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { DisplayNameSchema, UsernameSchema } from "./accounts.js";

/** Wire schemas for messages, attachments, read state, search and synced settings (07 §3.6–3.7). */

export const DEFAULT_MESSAGE_MAX_CHARS = 4000;
/** Hard ceiling at the schema layer; the configured limit (`text-chat.maxContentChars`) is lower or equal. */
export const MESSAGE_SCHEMA_MAX_CHARS = 20_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Mentions live in the raw text as tokens: `<@userId>`, `<@&roleId>`, `<#channelId>`, `@everyone`,
 * `@here`. The server derives `message_mention` rows from them; clients render them as names.
 */
export const MENTION_USER_RE = /<@([0-9A-HJKMNP-TV-Z]{26})>/g;
export const MENTION_ROLE_RE = /<@&([0-9A-HJKMNP-TV-Z]{26})>/g;
export const MENTION_CHANNEL_RE = /<#([0-9A-HJKMNP-TV-Z]{26})>/g;
export const MENTION_EVERYONE_RE = /(?<![\w<])@(everyone|here)\b/;

export const AttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  hasThumbnail: z.boolean(),
  /** Deleted by its uploader (design U16): the message shows "File removed". */
  removed: z.boolean(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const MessageAuthorSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
});
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  authorId: z.string(),
  /** Null for a deleted account: shown as "Deleted User" (11 §1.9). */
  author: MessageAuthorSchema.nullable(),
  content: z.string(),
  replyToId: z.string().nullable(),
  reply: z
    .object({
      id: z.string(),
      authorId: z.string().nullable(),
      authorName: z.string().nullable(),
      excerpt: z.string(),
      deleted: z.boolean(),
    })
    .nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  pinned: z.boolean(),
  attachments: z.array(AttachmentSchema),
  mentions: z.object({
    users: z.array(z.string()),
    roles: z.array(z.string()),
    everyone: z.boolean(),
  }),
  /** Echoed to the author's client for optimistic-send reconciliation (07 §5). */
  nonce: z.string().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const MessageCreateSchema = z.object({
  content: z.string().max(MESSAGE_SCHEMA_MAX_CHARS),
  replyToId: z.string().optional(),
  attachmentIds: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  nonce: z.string().min(1).max(64).optional(),
});
export type MessageCreate = z.infer<typeof MessageCreateSchema>;

export const MessageEditSchema = z.object({ content: z.string().min(1).max(MESSAGE_SCHEMA_MAX_CHARS) });

export const HistoryQuerySchema = z
  .object({
    before: z.string().optional(),
    after: z.string().optional(),
    around: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => [q.before, q.after, q.around].filter((x) => x !== undefined).length <= 1, {
    message: "give at most one of before, after, around",
  });

export const TypingStartArgsSchema = z.object({ channelId: z.string() });

// ---- read state ------------------------------------------------------------------------------

export const ReadStateEntrySchema = z.object({
  channelId: z.string(),
  lastReadId: z.string().nullable(),
  latestMessageId: z.string().nullable(),
  mentionCount: z.number().int(),
});
export type ReadStateEntry = z.infer<typeof ReadStateEntrySchema>;

export const AckRequestSchema = z.object({ messageId: z.string() });

// ---- search ----------------------------------------------------------------------------------

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  channelId: z.string().optional(),
  authorId: z.string().optional(),
  sort: z.enum(["newest", "relevance"]).default("newest"),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export const SearchResultSchema = z.object({
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
});

// ---- uploads ---------------------------------------------------------------------------------

export const UploadResultSchema = AttachmentSchema.omit({ removed: true, hasThumbnail: true }).extend({
  hasThumbnail: z.boolean(),
});

export const OwnAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  channelId: z.string().nullable(),
  messageId: z.string().nullable(),
  createdAt: z.string(),
});
export const OwnAttachmentsQuerySchema = z.object({
  sort: z.enum(["size", "date"]).default("date"),
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const StorageUsageSchema = z.object({ usedBytes: z.number(), quotaBytes: z.number() });

/** The owner's upload limits, changeable at runtime (`PATCH /admin/uploads`). */
export const UploadLimitsSchema = z.object({
  maxBytes: z.number(),
  userQuotaBytes: z.number(),
  /** What the server will never exceed for one file, whatever is set. */
  ceilingBytes: z.number(),
});
export const UploadLimitsPatchSchema = z
  .strictObject({
    maxBytes: z.number().int().min(1024).optional(),
    userQuotaBytes: z.number().int().min(0).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "Nothing to change." });
export type UploadLimits = z.infer<typeof UploadLimitsSchema>;

// ---- synced settings -------------------------------------------------------------------------

export const SettingsSchema = z.record(z.string().max(80), z.unknown());
export const SettingsPatchSchema = z
  .record(z.string().max(80), z.unknown())
  .refine((o) => Object.keys(o).length <= 50, { message: "too many keys" });

export const NOTIFICATION_LEVELS = ["all", "mentions", "none"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const ProfilePatchSchema = z.object({
  displayName: DisplayNameSchema.optional(),
  statusText: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().max(128))
    .nullable()
    .optional(),
});

export const RegisterRequestSchema = z.object({
  inviteCode: z.string().min(4).max(64).optional(),
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  password: z.string().min(1).max(256),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const ResetRedeemRequestSchema = z.object({
  code: z.string().min(6).max(64),
  newPassword: z.string().min(1).max(256),
});
