// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError } from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";

const ConfigSchema = z.strictObject({
  /** Seconds a member waits before nudging the same person again; 0 turns the pair cooldown off. */
  cooldownSecs: z.number().int().min(0).max(3600).default(60),
  /** Burst cap: how many nudges one member may send per window, whatever the target. */
  burst: z
    .strictObject({
      max: z.number().int().min(1).max(100).default(10),
      windowSecs: z.number().int().min(1).max(3600).default(60),
    })
    .prefault({}),
});

/**
 * "Anstupsen": a member pokes another member (issue #34). Online targets get `NUDGE_RECEIVED` over
 * the gateway; `nudge.sent` on the bus lets the push module reach offline members (12 §5.4).
 * Nothing is stored — the cooldowns live in the kv like every other rate limit.
 */
export default defineModule({
  id: "nudge",
  version: VERSION,
  dependsOn: ["accounts"],
  requiresPorts: ["pubsub"],
  configSchema: ConfigSchema,
  register(ctx) {
    const accounts = ctx.api.get<AccountsApi>("accounts");
    if (!accounts) throw new AppError("INTERNAL", "nudge: a dependency is missing");
    const kv = ctx.ports.pubsub.kv;
    const { cooldownSecs, burst } = ctx.config;

    const http = ctx.http.withTypeProvider<ZodTypeProvider>();
    http.post(
      "/members/:id/nudge",
      {
        preHandler: ctx.http.authenticate,
        schema: {
          params: z.object({ id: z.string().min(1).max(64) }),
          // `online` tells the sender whether the nudge arrived over a live socket right away.
          response: { 200: z.object({ online: z.boolean() }) },
        },
      },
      async (req, reply) => {
        const actor = req.actor!;
        const target = await accounts.getMember(req.params.id);
        if (!target || target.disabled) throw new AppError("NOT_FOUND", "No such member.");
        if (target.userId === actor.userId) throw new AppError("BAD_REQUEST", "You cannot nudge yourself.");
        // The pair cooldown is checked first so a repeated poke at one person does not
        // eat the sender's burst allowance.
        if (cooldownSecs > 0)
          await enforceRateLimit(
            kv,
            {
              key: `nudge:pair:${actor.userId}:${target.userId}`,
              max: 1,
              windowMs: cooldownSecs * 1000,
            },
            reply,
          );
        await enforceRateLimit(
          kv,
          { key: `nudge:burst:${actor.userId}`, max: burst.max, windowMs: burst.windowSecs * 1000 },
          reply,
        );
        // The nickname is what the target knows the sender by (07 §3.3 member record).
        const sender = await accounts.getMember(actor.userId);
        if (!sender) throw new AppError("PERMISSION_DENIED", "Only members can nudge.");
        const senderName = sender.nickname ?? sender.displayName;
        ctx.gateway.dispatchToUser(target.userId, "NUDGE_RECEIVED", {
          senderId: actor.userId,
          senderName,
        });
        ctx.events.emit(
          "nudge.sent",
          { senderId: actor.userId, senderName, targetId: target.userId },
          { requestId: req.id },
        );
        return { online: ctx.gateway.isOnline(target.userId) };
      },
    );

    ctx.capabilities.feature("nudge", true);
  },
});
