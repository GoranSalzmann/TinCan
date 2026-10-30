// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  AuditListQuerySchema,
  AuditListSchema,
  BanRequestSchema,
  BanSchema,
  KickRequestSchema,
  TimeoutRequestSchema,
  VoiceDisconnectRequestSchema,
  VoiceModRequestSchema,
  VoiceMoveRequestSchema,
} from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";
import type { RolesApi } from "../roles/api.js";
import type { TextChatApi } from "../text-chat/api.js";
import type { VoiceApi } from "../voice/api.js";
import { moderationMigrations, type ModerationTables } from "./schema.js";
import { ModerationService } from "./service.js";

const Id = z.string().min(1).max(64);

const ConfigSchema = z.strictObject({
  /** How often running timeouts are checked for expiry. */
  timeoutCheckMs: z.number().int().min(50).default(5000),
});

/** Kick, ban, timeout, server mute and move, and the audit log (11 §3). */
export default defineModule({
  id: "moderation",
  version: VERSION,
  dependsOn: ["accounts", "roles"],
  optionalDependsOn: ["voice", "text-chat"],
  requiresPorts: ["db"],
  migrations: moderationMigrations,
  configSchema: ConfigSchema,
  async register(ctx) {
    const accounts = ctx.api.get<AccountsApi>("accounts");
    const roles = ctx.api.get<RolesApi>("roles");
    if (!accounts || !roles) throw new AppError("INTERNAL", "moderation: a dependency is missing");
    const svc = new ModerationService({
      db: ctx.ports.db.as<ModerationTables>(),
      accounts,
      roles,
      voice: ctx.api.get<VoiceApi>("voice"),
      text: ctx.api.get<TextChatApi>("text-chat"),
      events: ctx.events,
      gateway: ctx.gateway,
      log: ctx.log,
    });
    await svc.init();

    // A banned person cannot sign in again, whatever their password (11 §1.5).
    accounts.setLoginBlocker(async (userId) => {
      const ban = await svc.isBanned(userId);
      if (!ban) return null;
      return {
        message: ban.reason
          ? `You are banned from this server: ${ban.reason}`
          : "You are banned from this server.",
      };
    });

    // Other modules report auditable facts on the bus instead of importing this one.
    ctx.events.on("audit.record", (entry, meta) => svc.record(entry, meta.requestId));
    ctx.jobs.every("moderation.timeouts", ctx.config.timeoutCheckMs, () => svc.expireTimeouts());

    const http = ctx.http.withTypeProvider<ZodTypeProvider>();
    const params = z.object({ id: Id });
    const who = (req: { actor: { userId: string } | null }) => req.actor!.userId;

    http.post(
      "/members/:id/kick",
      { preHandler: ctx.http.authenticate, schema: { params, body: KickRequestSchema } },
      async (req, reply) => {
        await svc.kick(who(req), req.params.id, req.body.reason, req.id);
        return reply.status(204).send();
      },
    );

    http.put(
      "/members/:id/ban",
      {
        preHandler: ctx.http.authenticate,
        schema: { params, body: BanRequestSchema, response: { 200: z.object({ purged: z.number().int() }) } },
      },
      async (req) => svc.ban(who(req), req.params.id, req.body, req.id),
    );

    http.delete(
      "/members/:id/ban",
      { preHandler: ctx.http.authenticate, schema: { params } },
      async (req, reply) => {
        await svc.unban(who(req), req.params.id, req.id);
        return reply.status(204).send();
      },
    );

    http.get(
      "/bans",
      { preHandler: ctx.http.authenticate, schema: { response: { 200: z.array(BanSchema) } } },
      async (req) => {
        await roles.assert(who(req), "BAN_MEMBERS");
        return svc.listBans();
      },
    );

    http.put(
      "/members/:id/timeout",
      { preHandler: ctx.http.authenticate, schema: { params, body: TimeoutRequestSchema } },
      async (req, reply) => {
        await svc.timeout(who(req), req.params.id, req.body, req.id);
        return reply.status(204).send();
      },
    );

    http.put(
      "/members/:id/voice",
      {
        preHandler: ctx.http.authenticate,
        schema: {
          params,
          body: VoiceModRequestSchema,
          response: { 200: z.object({ muted: z.boolean(), deafened: z.boolean() }) },
        },
      },
      async (req) => svc.voiceState(who(req), req.params.id, req.body, req.id),
    );

    http.post(
      "/members/:id/voice/move",
      { preHandler: ctx.http.authenticate, schema: { params, body: VoiceMoveRequestSchema } },
      async (req, reply) => {
        await svc.move(who(req), req.params.id, req.body.channelId, req.body.reason, req.id);
        return reply.status(204).send();
      },
    );

    http.post(
      "/members/:id/voice/disconnect",
      { preHandler: ctx.http.authenticate, schema: { params, body: VoiceDisconnectRequestSchema } },
      async (req, reply) => {
        await svc.disconnect(who(req), req.params.id, req.body.reason, req.id);
        return reply.status(204).send();
      },
    );

    http.get(
      "/audit-log",
      {
        preHandler: ctx.http.authenticate,
        schema: { querystring: AuditListQuerySchema, response: { 200: AuditListSchema } },
      },
      async (req) => {
        await roles.assert(who(req), "VIEW_AUDIT_LOG");
        return svc.list(req.query);
      },
    );

    ctx.capabilities.feature("moderation", true);
  },
});
