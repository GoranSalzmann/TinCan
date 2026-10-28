// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  ChangePasswordRequestSchema,
  GatewayTicketResponseSchema,
  InstanceInfoSchema,
  InstancePatchSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  SESSION_COOKIE,
  SessionInfoSchema,
  SetupRequestSchema,
  SetupVerifyRequestSchema,
  UserSchema,
} from "@tincan/shared";
import { clearedCookie, sessionCookie } from "../../http/cookies.js";
import { extractToken } from "../../http/app.js";
import type { AccountsService, ClientMeta, SessionResult } from "./service.js";

const meta = (req: FastifyRequest): ClientMeta => ({
  ip: req.ip,
  userAgent: String(req.headers["user-agent"] ?? ""),
});

const clientNameOf = (req: FastifyRequest, given?: string): string => {
  if (given) return given;
  const ua = String(req.headers["user-agent"] ?? "");
  if (/Electron/i.test(ua)) return "Desktop";
  return ua ? "Web" : "API";
};

export interface RouteDeps {
  secureCookie: boolean;
}

export function registerAccountRoutes(app: FastifyInstance, svc: AccountsService, deps: RouteDeps): void {
  const http = app.withTypeProvider<ZodTypeProvider>();

  const startSession = (reply: FastifyReply, s: SessionResult) => {
    // The cookie is what the web client uses; the token in the body is for desktop and CLI clients.
    reply.header(
      "set-cookie",
      sessionCookie(SESSION_COOKIE, s.token, {
        secure: deps.secureCookie,
        maxAgeSec: (s.expiresAt.getTime() - Date.now()) / 1000,
      }),
    );
    return { token: s.token, expiresAt: s.expiresAt.toISOString(), user: s.user };
  };

  // ---- first-run setup (11 §1.4) ----
  http.post("/auth/setup/verify", { schema: { body: SetupVerifyRequestSchema } }, async (req, reply) => {
    await svc.verifySetupToken(req.body.token, req.ip);
    return reply.status(204).send();
  });

  http.post(
    "/auth/setup",
    { schema: { body: SetupRequestSchema, response: { 200: LoginResponseSchema } } },
    async (req, reply) => startSession(reply, await svc.setup(req.body, meta(req), clientNameOf(req))),
  );

  // ---- login and sessions ----
  http.post(
    "/auth/login",
    { schema: { body: LoginRequestSchema, response: { 200: LoginResponseSchema } } },
    async (req, reply) =>
      startSession(
        reply,
        await svc.login({ ...req.body, clientName: clientNameOf(req, req.body.clientName) }, meta(req)),
      ),
  );

  http.post("/auth/logout", { preHandler: app.authenticate }, async (req, reply) => {
    await svc.revokeSession(req.actor!.userId, req.actor!.sessionId);
    reply.header("set-cookie", clearedCookie(SESSION_COOKIE, deps.secureCookie));
    return reply.status(204).send();
  });

  http.get(
    "/auth/sessions",
    { preHandler: app.authenticate, schema: { response: { 200: z.array(SessionInfoSchema) } } },
    async (req) => svc.listSessions(req.actor!.userId, req.actor!.sessionId),
  );

  http.delete(
    "/auth/sessions/:id",
    { preHandler: app.authenticate, schema: { params: z.object({ id: z.string().min(1).max(64) }) } },
    async (req, reply) => {
      if (!(await svc.revokeSession(req.actor!.userId, req.params.id)))
        throw new AppError("NOT_FOUND", "No such session.");
      return reply.status(204).send();
    },
  );

  http.post(
    "/auth/password",
    { preHandler: app.authenticate, schema: { body: ChangePasswordRequestSchema } },
    async (req, reply) => {
      await svc.changePassword(req.actor!, req.body.currentPassword, req.body.newPassword);
      return reply.status(204).send();
    },
  );

  http.post(
    "/auth/gateway-ticket",
    { preHandler: app.authenticate, schema: { response: { 200: GatewayTicketResponseSchema } } },
    async (req) => svc.issueGatewayTicket(req.actor!),
  );

  // ---- profile and instance ----
  http.get(
    "/users/@me",
    { preHandler: app.authenticate, schema: { response: { 200: UserSchema } } },
    async (req) => {
      const user = await svc.getUser(req.actor!.userId);
      if (!user) throw new AppError("NOT_FOUND", "No such user.");
      return user;
    },
  );

  http.get(
    "/admin/instance",
    { preHandler: app.requireOwner, schema: { response: { 200: InstanceInfoSchema } } },
    () => svc.getInstance(),
  );

  http.patch(
    "/admin/instance",
    {
      preHandler: app.requireOwner,
      schema: { body: InstancePatchSchema, response: { 200: InstanceInfoSchema } },
    },
    async (req) => svc.renameInstance(req.body.name),
  );

  // Kept so the cookie helper stays referenced by one code path.
  void extractToken;
}
