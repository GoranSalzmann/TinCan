// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  CategoryCreateSchema,
  CategoryPatchSchema,
  CategorySchema,
  ChannelCreateSchema,
  ChannelListSchema,
  ChannelPatchSchema,
  ChannelReorderSchema,
  ChannelSchema,
  OverwritePutSchema,
  OverwriteSchema,
  parsePermissions,
  permissionsToString,
  ALL_PERMISSIONS,
  CHANNEL_SCOPED,
} from "@tincan/shared";
import type { AccountsApi } from "../accounts/api.js";
import type { RolesApi } from "../roles/api.js";
import { channelWire, type ChannelsService } from "./service.js";

const Id = z.string().min(1).max(64);

export function registerChannelRoutes(
  app: FastifyInstance,
  svc: ChannelsService,
  roles: RolesApi,
  accounts: AccountsApi,
): void {
  const http = app.withTypeProvider<ZodTypeProvider>();

  http.get(
    "/channels",
    {
      preHandler: app.authenticate,
      schema: {
        querystring: z.object({ archived: z.coerce.boolean().optional() }),
        response: { 200: ChannelListSchema },
      },
    },
    async (req) => svc.listFor(req.actor!.userId, req.query.archived ? { archived: true } : {}),
  );

  http.post(
    "/channels",
    { preHandler: app.authenticate, schema: { body: ChannelCreateSchema, response: { 201: ChannelSchema } } },
    async (req, reply) => reply.status(201).send(channelWire(await svc.create(req.actor!.userId, req.body))),
  );

  // Registered before /channels/:id so "reorder" is not read as an ID.
  http.patch(
    "/channels/reorder",
    { preHandler: app.authenticate, schema: { body: ChannelReorderSchema } },
    async (req, reply) => {
      await svc.reorder(req.actor!.userId, req.body.items);
      return reply.status(204).send();
    },
  );

  http.patch(
    "/channels/:id",
    {
      preHandler: app.authenticate,
      schema: { params: z.object({ id: Id }), body: ChannelPatchSchema, response: { 200: ChannelSchema } },
    },
    async (req) => channelWire(await svc.update(req.actor!.userId, req.params.id, req.body)),
  );

  http.delete(
    "/channels/:id",
    { preHandler: app.authenticate, schema: { params: z.object({ id: Id }) } },
    async (req, reply) => {
      await svc.remove(req.actor!.userId, req.params.id);
      return reply.status(204).send();
    },
  );

  // ---- categories ----
  http.post(
    "/categories",
    {
      preHandler: app.authenticate,
      schema: { body: CategoryCreateSchema, response: { 201: CategorySchema } },
    },
    async (req, reply) => reply.status(201).send(await svc.createCategory(req.actor!.userId, req.body)),
  );
  http.patch(
    "/categories/:id",
    {
      preHandler: app.authenticate,
      schema: { params: z.object({ id: Id }), body: CategoryPatchSchema, response: { 200: CategorySchema } },
    },
    async (req) => svc.updateCategory(req.actor!.userId, req.params.id, req.body),
  );
  http.delete(
    "/categories/:id",
    { preHandler: app.authenticate, schema: { params: z.object({ id: Id }) } },
    async (req, reply) => {
      await svc.removeCategory(req.actor!.userId, req.params.id);
      return reply.status(204).send();
    },
  );

  // ---- overwrites (07 §3.4; they live here because they are edited in the channel's permissions pane) ----
  const overwriteParams = z.object({ id: Id, type: z.enum(["role", "member"]), targetId: Id });

  const requireChannel = (id: string) => {
    const c = svc.get(id);
    if (!c) throw new AppError("NOT_FOUND", "No such channel.");
    return c;
  };

  http.get(
    "/channels/:id/overwrites",
    {
      preHandler: app.authenticate,
      schema: { params: z.object({ id: Id }), response: { 200: z.array(OverwriteSchema) } },
    },
    async (req) => {
      requireChannel(req.params.id);
      await roles.assert(req.actor!.userId, "MANAGE_CHANNELS");
      return (await roles.listOverwrites(req.params.id)).map((o) => ({
        targetType: o.targetType,
        targetId: o.targetId,
        allow: permissionsToString(o.allow),
        deny: permissionsToString(o.deny),
      }));
    },
  );

  http.put(
    "/channels/:id/overwrites/:type/:targetId",
    {
      preHandler: app.authenticate,
      schema: { params: overwriteParams, body: OverwritePutSchema, response: { 200: OverwriteSchema } },
    },
    async (req) => {
      const { id, type, targetId } = req.params;
      requireChannel(id);
      let allow: bigint;
      let deny: bigint;
      try {
        // Only per-channel bits can be overwritten; instance-wide bits are ignored if sent.
        allow = parsePermissions(req.body.allow) & CHANNEL_SCOPED & ALL_PERMISSIONS;
        deny = parsePermissions(req.body.deny) & CHANNEL_SCOPED & ALL_PERMISSIONS;
      } catch {
        throw new AppError("VALIDATION_FAILED", "Permissions must be decimal bitsets.");
      }
      // A bit cannot be both allowed and denied: deny wins, as it is applied first and allow then adds back.
      allow &= ~deny;
      const actor = req.actor!.userId;
      await roles.authorizeOrThrow(actor, await overwriteAction(actor, id, type, targetId, allow));
      await roles.setOverwrite(id, { targetType: type, targetId, allow, deny });
      return {
        targetType: type,
        targetId,
        allow: permissionsToString(allow),
        deny: permissionsToString(deny),
      };
    },
  );

  http.delete(
    "/channels/:id/overwrites/:type/:targetId",
    { preHandler: app.authenticate, schema: { params: overwriteParams } },
    async (req, reply) => {
      const { id, type, targetId } = req.params;
      requireChannel(id);
      const actor = req.actor!.userId;
      await roles.authorizeOrThrow(actor, await overwriteAction(actor, id, type, targetId, 0n));
      await roles.deleteOverwrite(id, type, targetId);
      return reply.status(204).send();
    },
  );

  async function overwriteAction(
    actor: string,
    channelId: string,
    type: "role" | "member",
    targetId: string,
    allow: bigint,
  ) {
    const actorChannelPermissions = await roles.permissionsIn(actor, channelId);
    if (type === "role") {
      const role = await roles.getRole(targetId);
      if (!role) throw new AppError("NOT_FOUND", "No such role.");
      return { kind: "overwrite.set" as const, allow, actorChannelPermissions, role: roles.roleFacts(role) };
    }
    if (!(await accounts.getMember(targetId))) throw new AppError("NOT_FOUND", "No such member.");
    return {
      kind: "overwrite.set" as const,
      allow,
      actorChannelPermissions,
      member: await roles.memberFacts(targetId),
    };
  }
}
