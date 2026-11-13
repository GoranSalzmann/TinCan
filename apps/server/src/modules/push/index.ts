// SPDX-License-Identifier: AGPL-3.0-or-later
import webpush from "web-push";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  PushKeyResponseSchema,
  PushSubscriptionRequestSchema,
  PushUnsubscribeRequestSchema,
} from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";
import type { ChannelsApi } from "../channels/api.js";
import type { RolesApi } from "../roles/api.js";
import type { TextChatApi } from "../text-chat/api.js";
import { pushMigrations, type PushTables } from "./schema.js";
import { PushService, type PushSender } from "./service.js";
import { deriveVapidKeys, endpointAllowed } from "./vapid.js";

const ConfigSchema = z.strictObject({
  /** `full` puts the author and the start of the text in the push; `generic` says only "New message in #channel". */
  contentMode: z.enum(["full", "generic"]).default("full"),
  /** Contact for the push services (RFC 8292 `sub`): a `mailto:` or https URL. Defaults to the public URL when that is https. */
  subject: z.string().min(1).max(256).optional(),
  /** Extra push-service host suffixes to accept, for a browser vendor not in the built-in list. */
  extraHosts: z.array(z.string().min(3).max(253)).default([]),
  maxSubscriptionsPerUser: z.number().int().min(1).max(50).default(10),
});

/** Tests swap the network sender for a recorder. */
export const senderOverride: { current?: PushSender } = {};

/** Web Push (12 §5.4): messages reach members whose browser is closed. Off when the module is disabled. */
export default defineModule({
  id: "push",
  version: VERSION,
  dependsOn: ["accounts", "roles", "channels", "text-chat"],
  requiresPorts: ["db"],
  configSchema: ConfigSchema,
  migrations: pushMigrations,
  register(ctx) {
    const accounts = ctx.api.get<AccountsApi>("accounts");
    const roles = ctx.api.get<RolesApi>("roles");
    const channels = ctx.api.get<ChannelsApi>("channels");
    const text = ctx.api.get<TextChatApi>("text-chat");
    if (!accounts || !roles || !channels || !text)
      throw new AppError("INTERNAL", "push: a dependency is missing");

    const keys = deriveVapidKeys(ctx.core.security.instanceSecret);
    const publicUrl = ctx.core.instance.publicUrl;
    const subject =
      ctx.config.subject ??
      (publicUrl.startsWith("https://") ? publicUrl : "https://github.com/GoranSalzmann/TinCan");
    const vapid = { subject, publicKey: keys.publicKey, privateKey: keys.privateKey };

    const real: PushSender = {
      async send(target, payload, o) {
        await webpush.sendNotification(target, payload, {
          vapidDetails: vapid,
          TTL: o.ttlSecs,
          urgency: o.urgency,
          topic: o.topic.slice(0, 32),
          timeout: 10_000,
        });
      },
    };

    const sender: PushSender = { send: (...a) => (senderOverride.current ?? real).send(...a) };
    const svc = new PushService({
      db: ctx.ports.db.as<PushTables>(),
      sender,
      accounts,
      roles,
      channels,
      text,
      isOnline: (u) => ctx.gateway.isOnline(u),
      contentMode: ctx.config.contentMode,
      maxPerUser: ctx.config.maxSubscriptionsPerUser,
      log: ctx.log,
    });

    ctx.events.on("message.created", (e) => svc.notifyMessage(e));
    ctx.events.on("session.revoked", ({ sessionId }) => svc.removeForSession(sessionId));

    const http = ctx.http.withTypeProvider<ZodTypeProvider>();
    http.get(
      "/push/vapid-key",
      { preHandler: ctx.http.authenticate, schema: { response: { 200: PushKeyResponseSchema } } },
      async () => ({ publicKey: keys.publicKey }),
    );
    http.put(
      "/push/subscription",
      {
        preHandler: ctx.http.authenticate,
        schema: { body: PushSubscriptionRequestSchema, response: { 204: z.null() } },
      },
      async (req, reply) => {
        if (!endpointAllowed(req.body.endpoint, ctx.config.extraHosts))
          throw new AppError("VALIDATION_FAILED", "That push service is not supported.");
        const actor = req.actor!;
        await svc.subscribe(actor.userId, actor.sessionId, req.body);
        return reply.code(204).send(null);
      },
    );
    http.delete(
      "/push/subscription",
      {
        preHandler: ctx.http.authenticate,
        schema: { body: PushUnsubscribeRequestSchema, response: { 204: z.null() } },
      },
      async (req, reply) => {
        await svc.unsubscribe(req.actor!.userId, req.body.endpoint);
        return reply.code(204).send(null);
      },
    );

    ctx.capabilities.feature("push", true);
  },
});
