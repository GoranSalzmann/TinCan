// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { HistoryQuerySchema, MessageCreateSchema, MessageEditSchema, MessageSchema } from "@tincan/shared";
import type { TextChatService } from "./service.js";

const Id = z.string().min(1).max(64);

export function registerTextRoutes(app: FastifyInstance, svc: TextChatService): void {
  const http = app.withTypeProvider<ZodTypeProvider>();
  const channel = z.object({ id: Id });
  const message = z.object({ id: Id, mid: Id });

  http.get(
    "/channels/:id/messages",
    {
      preHandler: app.authenticate,
      schema: { params: channel, querystring: HistoryQuerySchema, response: { 200: z.array(MessageSchema) } },
    },
    async (req) => svc.history(req.actor!.userId, req.params.id, req.query),
  );

  http.post(
    "/channels/:id/messages",
    {
      preHandler: app.authenticate,
      schema: {
        params: channel,
        body: MessageCreateSchema,
        response: { 200: MessageSchema, 201: MessageSchema },
      },
    },
    async (req, reply) => {
      const { message, created } = await svc.create(req.actor!.userId, req.params.id, req.body, req.id);
      // 201 for a new message, 200 when a retry with the same nonce returned the original (07 §1).
      return reply.status(created ? 201 : 200).send(message);
    },
  );

  http.patch(
    "/channels/:id/messages/:mid",
    {
      preHandler: app.authenticate,
      schema: { params: message, body: MessageEditSchema, response: { 200: MessageSchema } },
    },
    async (req) => svc.edit(req.actor!.userId, req.params.id, req.params.mid, req.body.content, req.id),
  );

  http.delete(
    "/channels/:id/messages/:mid",
    { preHandler: app.authenticate, schema: { params: message } },
    async (req, reply) => {
      await svc.remove(req.actor!.userId, req.params.id, req.params.mid, req.id);
      return reply.status(204).send();
    },
  );

  http.get(
    "/channels/:id/pins",
    { preHandler: app.authenticate, schema: { params: channel, response: { 200: z.array(MessageSchema) } } },
    async (req) => svc.pins(req.actor!.userId, req.params.id),
  );

  http.put(
    "/channels/:id/pins/:mid",
    { preHandler: app.authenticate, schema: { params: message } },
    async (req, reply) => {
      await svc.setPinned(req.actor!.userId, req.params.id, req.params.mid, true);
      return reply.status(204).send();
    },
  );

  http.delete(
    "/channels/:id/pins/:mid",
    { preHandler: app.authenticate, schema: { params: message } },
    async (req, reply) => {
      await svc.setPinned(req.actor!.userId, req.params.id, req.params.mid, false);
      return reply.status(204).send();
    },
  );
}
