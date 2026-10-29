// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  EffectivePermissionsSchema,
  MemberPatchSchema,
  MemberSchema,
  RoleCreateSchema,
  RolePatchSchema,
  RoleSchema,
  permissionsToString,
} from "@tincan/shared";
import type { AccountsApi } from "../accounts/api.js";
import type { RolesService } from "./service.js";
import { wire } from "./service.js";

const Id = z.string().min(1).max(64);

export function registerRoleRoutes(app: FastifyInstance, svc: RolesService, accounts: AccountsApi): void {
  const http = app.withTypeProvider<ZodTypeProvider>();

  http.get(
    "/roles",
    { preHandler: app.authenticate, schema: { response: { 200: z.array(RoleSchema) } } },
    async () => (await svc.listRoles()).map(wire),
  );

  http.post(
    "/roles",
    { preHandler: app.authenticate, schema: { body: RoleCreateSchema, response: { 201: RoleSchema } } },
    async (req, reply) => reply.status(201).send(wire(await svc.createRole(req.actor!.userId, req.body))),
  );

  http.patch(
    "/roles/:id",
    {
      preHandler: app.authenticate,
      schema: { params: z.object({ id: Id }), body: RolePatchSchema, response: { 200: RoleSchema } },
    },
    async (req) => wire(await svc.updateRole(req.actor!.userId, req.params.id, req.body)),
  );

  http.delete(
    "/roles/:id",
    { preHandler: app.authenticate, schema: { params: z.object({ id: Id }) } },
    async (req, reply) => {
      await svc.deleteRole(req.actor!.userId, req.params.id);
      return reply.status(204).send();
    },
  );

  // ---- members ----
  const MembersPage = z.object({ items: z.array(MemberSchema), nextCursor: z.string().nullable() });

  http.get(
    "/members",
    {
      preHandler: app.authenticate,
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
          after: Id.optional(),
        }),
        response: { 200: MembersPage },
      },
    },
    async (req) => {
      const all = await accounts.listMembers();
      const start = req.query.after ? all.findIndex((m) => m.userId === req.query.after) + 1 : 0;
      const page = all.slice(start, start + req.query.limit);
      const items = await Promise.all(page.map((m) => svc.memberDto(m)));
      const more = start + page.length < all.length;
      return { items, nextCursor: more ? (page[page.length - 1]?.userId ?? null) : null };
    },
  );

  http.get(
    "/members/:userId",
    {
      preHandler: app.authenticate,
      schema: { params: z.object({ userId: Id }), response: { 200: MemberSchema } },
    },
    async (req) => {
      const m = await accounts.getMember(req.params.userId);
      if (!m) throw new AppError("NOT_FOUND", "No such member.");
      return svc.memberDto(m);
    },
  );

  const setNickname = async (actorId: string, userId: string, nickname: string | null | undefined) => {
    if (nickname === undefined) return;
    const target = await accounts.getMember(userId);
    if (!target) throw new AppError("NOT_FOUND", "No such member.");
    await svc.authorizeOrThrow(actorId, {
      kind: "member.nickname",
      member: await svc.memberFacts(userId),
      self: actorId === userId,
    });
    await accounts.setNickname(userId, nickname);
    await svc.announceMember(userId);
  };

  http.patch(
    "/members/@me",
    {
      preHandler: app.authenticate,
      schema: { body: MemberPatchSchema, response: { 200: MemberSchema } },
    },
    async (req) => {
      await setNickname(req.actor!.userId, req.actor!.userId, req.body.nickname);
      return svc.memberDto((await accounts.getMember(req.actor!.userId))!);
    },
  );

  http.patch(
    "/members/:userId",
    {
      preHandler: app.authenticate,
      schema: { params: z.object({ userId: Id }), body: MemberPatchSchema, response: { 200: MemberSchema } },
    },
    async (req) => {
      await setNickname(req.actor!.userId, req.params.userId, req.body.nickname);
      const m = await accounts.getMember(req.params.userId);
      if (!m) throw new AppError("NOT_FOUND", "No such member.");
      return svc.memberDto(m);
    },
  );

  const roleParams = z.object({ userId: Id, roleId: Id });
  http.put(
    "/members/:userId/roles/:roleId",
    { preHandler: app.authenticate, schema: { params: roleParams } },
    async (req, reply) => {
      await svc.assignRole(req.actor!.userId, req.params.userId, req.params.roleId);
      return reply.status(204).send();
    },
  );
  http.delete(
    "/members/:userId/roles/:roleId",
    { preHandler: app.authenticate, schema: { params: roleParams } },
    async (req, reply) => {
      await svc.unassignRole(req.actor!.userId, req.params.userId, req.params.roleId);
      return reply.status(204).send();
    },
  );

  /** "Preview as member" and the effective-permissions view (11 §4): every step of the computation. */
  http.get(
    "/members/:userId/permissions",
    {
      preHandler: app.authenticate,
      schema: {
        params: z.object({ userId: Id }),
        querystring: z.object({ channelId: Id }),
        response: { 200: EffectivePermissionsSchema },
      },
    },
    async (req) => {
      await svc.assert(req.actor!.userId, "MANAGE_ROLES");
      const r = await svc.explain(req.params.userId, req.query.channelId);
      return {
        permissions: permissionsToString(r.permissions),
        steps: r.steps.map((s) => ({
          step: s.step,
          before: permissionsToString(s.before),
          after: permissionsToString(s.after),
        })),
      };
    },
  );
}
