// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  E2eeKeySchema,
  E2eeSettingPatchSchema,
  E2eeSettingSchema,
  VideoLimitsPatchSchema,
  VideoLimitsSchema,
  VoiceJoinRequestSchema,
  VoiceJoinResponseSchema,
  VoiceParticipantSchema,
} from "@tincan/shared";
import type { RolesApi } from "../roles/api.js";
import type { VoiceService } from "./service.js";

const Id = z.string().min(1).max(64);

/**
 * 07 §3.8. The webhook is mounted under /api/v1/internal and is signed by LiveKit; Caddy answers 404 for
 * /api/internal/* and /api/v1/internal/*, so only LiveKit on the same host reaches it (18 T5, T26).
 */
export function registerVoiceRoutes(app: FastifyInstance, svc: VoiceService, roles: RolesApi): void {
  const http = app.withTypeProvider<ZodTypeProvider>();

  http.post(
    "/voice/channels/:id/join",
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ id: Id }),
        response: { 200: VoiceJoinResponseSchema },
      },
    },
    async (req) => {
      // The body is optional (older clients send none), so it is parsed here rather than by the route schema.
      const body = VoiceJoinRequestSchema.safeParse(req.body ?? {});
      if (!body.success) throw new AppError("VALIDATION_FAILED", "The join request is not valid.");
      return svc.join(req.actor!.userId, req.params.id, body.data.e2ee === true);
    },
  );

  // A client that missed a rekey asks again (10 §8). Only someone in the call gets a key.
  http.get(
    "/voice/channels/:id/e2ee-key",
    {
      preHandler: app.authenticate,
      schema: { params: z.object({ id: Id }), response: { 200: E2eeKeySchema } },
    },
    async (req) => svc.keyFor(req.actor!.userId, req.params.id),
  );

  http.get(
    "/admin/voice/e2ee",
    { preHandler: app.requireOwner, schema: { response: { 200: E2eeSettingSchema } } },
    () => ({ enabled: svc.e2eeEnabled() }),
  );

  http.patch(
    "/admin/voice/e2ee",
    {
      preHandler: app.requireOwner,
      schema: { body: E2eeSettingPatchSchema, response: { 200: E2eeSettingSchema } },
    },
    async (req) => {
      await svc.setE2eeDefault(req.body.enabled);
      return { enabled: svc.e2eeEnabled() };
    },
  );

  // The owner's server-wide video caps (18 §L): they apply to the next join, with no restart.
  http.get(
    "/admin/voice",
    { preHandler: app.requireOwner, schema: { response: { 200: VideoLimitsSchema } } },
    () => svc.videoLimits(),
  );

  http.patch(
    "/admin/voice",
    {
      preHandler: app.requireOwner,
      schema: { body: VideoLimitsPatchSchema, response: { 200: VideoLimitsSchema } },
    },
    async (req) => svc.updateVideoLimits(req.body),
  );

  http.post(
    "/voice/diagnostics",
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: z.object({ url: z.string(), token: z.string(), roomName: z.string(), expiresAt: z.string() }),
        },
      },
    },
    async (req) => svc.diagnosticsToken(req.actor!.userId),
  );

  http.post("/voice/leave", { preHandler: app.authenticate }, async (req, reply) => {
    await svc.leave(req.actor!.userId);
    return reply.status(204).send();
  });

  http.get(
    "/voice/state",
    {
      preHandler: app.authenticate,
      schema: {
        response: { 200: z.object({ voice: z.record(z.string(), z.array(VoiceParticipantSchema)) }) },
      },
    },
    async (req) => ({ voice: await svc.snapshotFor(req.actor!.userId) }),
  );

  // Operator view of the reconciler and webhook counters (until the metrics module exists).
  http.get("/voice/status", { preHandler: app.authenticate }, async (req) => {
    if (!(await roles.can(req.actor!.userId, "MANAGE_INSTANCE"))) {
      throw new AppError("PERMISSION_DENIED", "Only people who manage the instance can see this.");
    }
    return svc.stats;
  });

  // LiveKit posts `application/webhook+json`; the signature covers the exact bytes, so keep them as a string.
  app.addContentTypeParser("application/webhook+json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });
  app.post("/internal/livekit/webhook", async (req, reply) => {
    await svc.handleWebhook(typeof req.body === "string" ? req.body : "", req.headers.authorization);
    return reply.status(200).send({});
  });
}
