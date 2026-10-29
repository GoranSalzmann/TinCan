// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import {
  AppError,
  DEFAULT_MESSAGE_MAX_CHARS,
  NOTIFICATION_LEVELS,
  TypingStartArgsSchema,
} from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";
import type { ChannelsApi } from "../channels/api.js";
import type { RolesApi } from "../roles/api.js";
import type { UploadsApi } from "../uploads/api.js";
import type { TextChatApi } from "./api.js";
import { registerTextRoutes } from "./routes.js";
import { textChatMigrations, type TextChatTables } from "./schema.js";
import { searchText, TextChatService } from "./service.js";

const ConfigSchema = z.strictObject({
  maxContentChars: z.number().int().min(100).max(20_000).default(DEFAULT_MESSAGE_MAX_CHARS),
  /** 07 §2.4: 10 messages per 10 s per user and channel. */
  createRate: z
    .strictObject({
      max: z.number().int().min(1).default(10),
      windowSecs: z.number().int().min(1).default(10),
    })
    .prefault({}),
});

/** Messages, history, edit/delete, replies, mentions, pins and typing (06 §3.5, 07 §3.6). */
export default defineModule({
  id: "text-chat",
  version: VERSION,
  dependsOn: ["channels"],
  optionalDependsOn: ["uploads"],
  requiresPorts: ["db", "pubsub"],
  configSchema: ConfigSchema,
  migrations: textChatMigrations,
  register(ctx) {
    const roles = ctx.api.get<RolesApi>("roles");
    const channels = ctx.api.get<ChannelsApi>("channels");
    const accounts = ctx.api.get<AccountsApi>("accounts");
    if (!roles || !channels || !accounts)
      throw new AppError("INTERNAL", "text-chat: a dependency is missing");
    const svc = new TextChatService({
      db: ctx.ports.db.as<TextChatTables>(),
      kv: ctx.ports.pubsub.kv,
      roles,
      channels,
      accounts,
      uploads: ctx.api.get<UploadsApi>("uploads"),
      gateway: ctx.gateway,
      events: ctx.events,
      outbox: ctx.outbox,
      settings: ctx.config,
    });

    registerTextRoutes(ctx.http, svc);
    // "File removed" shows up in place on everyone's screen (design U16).
    ctx.events.on("attachment.removed", async ({ messageId, channelId }) => {
      if (!messageId || !channelId) return;
      const [message] = await svc.getMessages([messageId]);
      if (message) ctx.gateway.dispatchToChannel(channelId, "MESSAGE_UPDATE", { message });
    });
    ctx.gateway.onCommand("typing.start", async (args, { actor }) => {
      const parsed = TypingStartArgsSchema.safeParse(args);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED", "typing.start needs a channelId.");
      await svc.typing(actor.userId, parsed.data.channelId);
    });

    // Notification preferences follow the user across devices (12 §8).
    const level = z.enum(NOTIFICATION_LEVELS);
    accounts.registerSetting("notifications.default", level);
    accounts.registerSetting(
      "notifications.channel.*",
      z.strictObject({ level: level.optional(), mutedUntil: z.number().int().nullable().optional() }),
    );

    ctx.capabilities.feature("text-chat", { maxContentChars: ctx.config.maxContentChars });
    ctx.capabilities.limit("messageMaxChars", ctx.config.maxContentChars);

    const api: TextChatApi = {
      getMessages: (ids) => svc.getMessages(ids),
      latestMessageIds: (ids) => svc.latestMessageIds(ids),
      mentionCounts: (u, r, e) => svc.mentionCounts(u, r, e),
      messageExists: (c, m) => svc.messageExists(c, m),
      documents: (after, limit) => svc.documents(after, limit),
      searchText,
    };
    ctx.api.provide("text-chat", api);
  },
});
