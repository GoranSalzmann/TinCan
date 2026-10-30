// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Logger as PinoLogger } from "pino";
import {
  AppError,
  CSRF_HEADER,
  MAX_CLIENT_FRAME_BYTES,
  SESSION_COOKIE,
  newId,
  type ErrorEnvelope,
} from "@tincan/shared";
import { HTTP_BUCKETS, type MetricsRegistry } from "../framework/metrics.js";
import type { Actor, Authenticator, RequestGate } from "../framework/types.js";
import type { Kv } from "@tincan/pubsub";
import { parseCookies } from "./cookies.js";
import { enforceRateLimit } from "./rate-limit.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the `authenticate` hook on routes that use it. */
    actor: Actor | null;
  }
  interface FastifyInstance {
    /** preHandler: 401 unless a valid session accompanies the request. */
    authenticate: (req: FastifyRequest) => Promise<void>;
    /** preHandler: authenticate, then require the instance owner. */
    requireOwner: (req: FastifyRequest) => Promise<void>;
    /** Every route registered, for the test that proves each one asks for a login or is on the public list (S-04). */
    routeTable: RouteInfo[];
  }
}

export interface SecurityState {
  authenticator: Authenticator | null;
  gates: RequestGate[];
}

export interface RateLimits {
  readsPerMinute: number;
  writesPerMinute: number;
  perIpPerMinute: number;
}

export interface HttpOptions {
  logger: PinoLogger;
  trustProxy: boolean;
  security: SecurityState;
  metrics?: MetricsRegistry;
  /** Storage for the API rate limits; without it none are applied (unit tests of the plumbing). */
  kv?: Kv;
  rateLimits?: RateLimits;
}

export interface RouteInfo {
  method: string;
  url: string;
  /** True when `authenticate` or `requireOwner` runs before the handler. */
  auth: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function extractToken(req: FastifyRequest): { token: string; via: "bearer" | "cookie" } | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m?.[1]) return { token: m[1], via: "bearer" };
  }
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return cookie ? { token: cookie, via: "cookie" } : null;
}

function envelope(
  code: ErrorEnvelope["error"]["code"],
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
) {
  const body: ErrorEnvelope = { error: { code, message, requestId, ...(details ? { details } : {}) } };
  return body;
}

export async function createHttpApp(opts: HttpOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.logger,
    trustProxy: opts.trustProxy,
    bodyLimit: 256 * 1024,
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && /^[\w-]{8,64}$/.test(given) ? given : newId();
    },
  });
  // Fastify strips unknown fields from responses and fails a body that breaks its schema (T1).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(websocket, { options: { maxPayload: MAX_CLIENT_FRAME_BYTES } });

  app.decorateRequest("actor", null);
  const routeTable: RouteInfo[] = [];
  app.decorate("routeTable", routeTable);
  app.addHook("onRoute", (r) => {
    const hooks = [r.onRequest, r.preParsing, r.preValidation, r.preHandler]
      .flat()
      .filter((h): h is NonNullable<typeof h> => typeof h === "function");
    const auth = hooks.some((h) => h === app.authenticate || h === app.requireOwner);
    for (const method of Array.isArray(r.method) ? r.method : [r.method])
      routeTable.push({ method, url: r.url, auth });
  });

  const authenticate = async (req: FastifyRequest) => {
    const found = extractToken(req);
    const auth = opts.security.authenticator;
    if (!found || !auth) throw new AppError("UNAUTHENTICATED", "Log in to continue.");
    // The web session lives in an HttpOnly cookie; require a custom header so a cross-site form cannot ride on it (11 §1.2).
    if (found.via === "cookie" && !SAFE_METHODS.has(req.method) && !req.headers[CSRF_HEADER]) {
      throw new AppError("PERMISSION_DENIED", "Missing CSRF header.");
    }
    const actor = await auth.fromToken(found.token);
    if (!actor) throw new AppError("UNAUTHENTICATED", "Your session has ended. Log in again.");
    req.actor = actor;
    // A signed-in member's calls are bounded per minute, reads and writes apart (S-11).
    if (opts.kv && opts.rateLimits) {
      const write = !SAFE_METHODS.has(req.method);
      await enforceRateLimit(opts.kv, {
        key: `api:${write ? "w" : "r"}:${actor.userId}`,
        max: write ? opts.rateLimits.writesPerMinute : opts.rateLimits.readsPerMinute,
        windowMs: 60_000,
      });
    }
  };
  app.decorate("authenticate", authenticate);
  app.decorate("requireOwner", async (req: FastifyRequest) => {
    await authenticate(req);
    if (!req.actor?.isInstanceOwner) throw new AppError("PERMISSION_DENIED", "Only the owner can do that.");
  });

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    // Everything from one address, signed in or not. LiveKit's webhooks come from loopback in bursts and are signed.
    if (opts.kv && opts.rateLimits && !req.url.startsWith("/api/v1/internal/")) {
      await enforceRateLimit(opts.kv, {
        key: `api:ip:${req.ip}`,
        max: opts.rateLimits.perIpPerMinute,
        windowMs: 60_000,
      });
    }
    for (const gate of opts.security.gates) await gate(req);
  });

  if (opts.metrics) {
    const total = opts.metrics.counter("tincan_http_requests_total", "HTTP requests by route and status", [
      "method",
      "route",
      "status",
    ]);
    const duration = opts.metrics.histogram(
      "tincan_http_request_duration_seconds",
      "HTTP request duration by route",
      ["method", "route"],
      HTTP_BUCKETS,
    );
    // The route pattern, never the URL: IDs in paths must not become label values.
    app.addHook("onResponse", async (req, reply) => {
      const route = req.routeOptions?.url ?? "unmatched";
      total.inc({ method: req.method, route, status: String(reply.statusCode) });
      duration.observe(reply.elapsedTime / 1000, { method: req.method, route });
    });
  }

  app.addHook("onSend", async (req, reply) => {
    // Lets a user quote the id of a failed call, and lets a log line be found from it (18 T34).
    reply.header("X-Request-Id", req.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    // Routes that serve immutable files set their own policy.
    if (req.url.startsWith("/api/") && !reply.hasHeader("Cache-Control"))
      reply.header("Cache-Control", "no-store");
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send(envelope("NOT_FOUND", "Not found.", req.id));
  });

  app.setErrorHandler(
    (err: Error & { statusCode?: number; code?: string }, req: FastifyRequest, reply: FastifyReply) => {
      if (err instanceof AppError) {
        const retry = err.code === "RATE_LIMITED" ? Number(err.details?.retryAfterMs) : NaN;
        if (Number.isFinite(retry)) void reply.header("Retry-After", String(Math.ceil(retry / 1000)));
        return reply.status(err.httpStatus).send(envelope(err.code, err.message, req.id, err.details));
      }
      if (hasZodFastifySchemaValidationErrors(err)) {
        const issues = err.validation.map((v) => ({
          path: v.instancePath.replace(/^\//, "").replace(/\//g, "."),
          message: v.message ?? "invalid",
        }));
        return reply
          .status(400)
          .send(envelope("VALIDATION_FAILED", "The request is not valid.", req.id, { issues }));
      }
      if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.status(413).send(envelope("PAYLOAD_TOO_LARGE", "The request is too large.", req.id));
      }
      if (err.statusCode === 400 || err.code?.startsWith("FST_ERR_CTP")) {
        return reply.status(400).send(envelope("BAD_REQUEST", "The request could not be read.", req.id));
      }
      if (isResponseSerializationError(err)) {
        req.log.error({ err }, "response did not match its schema");
      } else {
        req.log.error({ err }, "unhandled error");
      }
      return reply.status(500).send(envelope("INTERNAL", "Something went wrong on the server.", req.id));
    },
  );

  // The pino-typed instance is what modules see as a plain FastifyInstance.
  return app as unknown as FastifyInstance;
}

/** A stable per-process node id for broadcasts and leases. */
export const NODE_ID = randomUUID();
