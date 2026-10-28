// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyBaseLogger } from "fastify";
import type { RawData, WebSocket } from "ws";
import {
  API_VERSION,
  AppError,
  ClientFrameSchema,
  CloseCode,
  CommandPayloadSchema,
  GATEWAY_COMMANDS,
  HeartbeatPayloadSchema,
  IdentifyPayloadSchema,
  Op,
  ResumePayloadSchema,
  type HelloPayload,
} from "@tincan/shared";
import type { Actor, Authenticator } from "../framework/types.js";
import type { Connection, GatewayHub, GatewaySession } from "./hub.js";

export interface GatewayDeps {
  hub: GatewayHub;
  authenticator: () => Authenticator | null;
  log: FastifyBaseLogger;
  heartbeatIntervalMs: number;
  identifyTimeoutMs: number;
  maxSendQueueBytes: number;
  /** Per-socket op budget: a burst of `burst`, refilled at `perSecond`. */
  opLimit?: { burst: number; perSecond: number };
  now?: () => number;
}

const OPEN = 1;

/**
 * One gateway socket (07 §4): HELLO → IDENTIFY → READY → dispatches, with heartbeats, RESUME from the
 * hub's ring buffer, a per-socket op rate limit and slow-consumer disconnects.
 */
export function handleConnection(
  socket: WebSocket,
  clientVersion: string | undefined,
  deps: GatewayDeps,
): void {
  const now = deps.now ?? Date.now;
  const { hub } = deps;
  const limit = deps.opLimit ?? { burst: 40, perSecond: 20 };
  let session: GatewaySession | null = null;
  let closed = false;
  let lastHeartbeat = now();
  let tokens = limit.burst;
  let lastRefill = now();
  // Assigned once the handlers below exist; `close` may run before that on the version-mismatch path.
  // eslint-disable-next-line prefer-const
  let identifyTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let queue: Promise<void> = Promise.resolve();

  const conn: Connection = {
    send(frame) {
      if (closed || socket.readyState !== OPEN) return;
      if (socket.bufferedAmount > deps.maxSendQueueBytes) {
        // Resumable close: the events stay in the ring buffer (05 §5 backpressure).
        close(CloseCode.SLOW_CONSUMER, "send queue overflow");
        return;
      }
      socket.send(frame);
    },
    close(code, reason) {
      close(code, reason);
    },
  };

  function sendOp(op: number, d: unknown, extra: Record<string, unknown> = {}): void {
    conn.send(JSON.stringify({ op, ...extra, d }));
  }

  function close(code: number, reason: string): void {
    if (closed) return;
    closed = true;
    clearTimeout(identifyTimer);
    clearInterval(heartbeatTimer);
    if (session && session.conn === conn) {
      session.conn = null;
      session.detachedAt = now();
    }
    try {
      socket.close(code, reason.slice(0, 100));
    } catch {
      socket.terminate();
    }
  }

  function startHeartbeatWatch(): void {
    lastHeartbeat = now();
    heartbeatTimer = setInterval(
      () => {
        // Missing client heartbeats for two intervals → the client is gone (07 §4.3).
        if (now() - lastHeartbeat > deps.heartbeatIntervalMs * 2)
          close(CloseCode.SESSION_TIMED_OUT, "heartbeat timeout");
      },
      Math.max(10, Math.floor(deps.heartbeatIntervalMs / 2)),
    );
    heartbeatTimer.unref();
  }

  function spend(): boolean {
    const t = now();
    tokens = Math.min(limit.burst, tokens + ((t - lastRefill) / 1000) * limit.perSecond);
    lastRefill = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  async function authenticate(creds: {
    token?: string | undefined;
    ticket?: string | undefined;
  }): Promise<Actor | null> {
    const auth = deps.authenticator();
    if (!auth) return null;
    try {
      if (creds.token !== undefined) return await auth.fromToken(creds.token);
      if (creds.ticket !== undefined) return await auth.fromTicket(creds.ticket);
    } catch (err) {
      deps.log.error({ err }, "gateway authentication failed");
    }
    return null;
  }

  async function identify(d: unknown): Promise<void> {
    if (session) return close(CloseCode.ALREADY_AUTHENTICATED, "already authenticated");
    const parsed = IdentifyPayloadSchema.safeParse(d);
    if (!parsed.success) return close(CloseCode.INVALID_OPCODE, "malformed IDENTIFY");
    const actor = await authenticate(parsed.data);
    if (closed) return;
    if (!actor) return close(CloseCode.AUTH_FAILED, "authentication failed");
    clearTimeout(identifyTimer);

    const contributions = await Promise.all(hub.readyContributors.map(async (c) => c(actor)));
    if (closed) return;
    const created = hub.create(actor);
    created.conn = conn;
    session = created;
    const ready = Object.assign({ sessionId: created.id }, ...contributions) as Record<string, unknown>;
    sendOp(Op.DISPATCH, ready, { t: "READY", s: 0 });
    startHeartbeatWatch();
  }

  async function resume(d: unknown): Promise<void> {
    if (session) return close(CloseCode.ALREADY_AUTHENTICATED, "already authenticated");
    const parsed = ResumePayloadSchema.safeParse(d);
    if (!parsed.success) return close(CloseCode.INVALID_OPCODE, "malformed RESUME");
    const actor = await authenticate(parsed.data);
    if (closed) return;
    if (!actor) return close(CloseCode.AUTH_FAILED, "authentication failed");

    const found = hub.sessions.get(parsed.data.sessionId);
    if (!found || found.actor.userId !== actor.userId) {
      // Unknown or expired: the client starts over with IDENTIFY on this same socket.
      sendOp(Op.INVALID_SESSION, { resumable: false });
      return;
    }
    if (parsed.data.lastSeq > found.seq)
      return close(CloseCode.INVALID_SEQUENCE, "sequence is ahead of the server");
    const replay = found.ring.since(parsed.data.lastSeq, found.seq, now());
    if (replay === null) {
      hub.sessions.delete(found.id);
      sendOp(Op.INVALID_SESSION, { resumable: false });
      return;
    }
    clearTimeout(identifyTimer);
    // From here to the end of the replay nothing awaits, so no new event can overtake the replayed ones.
    found.conn?.close(CloseCode.NORMAL, "resumed on another connection");
    found.conn = conn;
    found.detachedAt = null;
    session = found;
    for (const frame of replay) conn.send(frame);
    sendOp(Op.DISPATCH, { replayed: replay.length }, { t: "RESUMED", s: found.seq });
    startHeartbeatWatch();
  }

  async function command(d: unknown): Promise<void> {
    const parsed = CommandPayloadSchema.safeParse(d);
    if (!parsed.success) return close(CloseCode.INVALID_OPCODE, "malformed COMMAND");
    const { cmd, args, id } = parsed.data;
    const result = (error?: { code: string; message: string }) =>
      sendOp(Op.COMMAND_RESULT, error ? { id, ok: false, error } : { id, ok: true });
    const handler = hub.commands.get(cmd);
    if (!handler) {
      // Known command of a module that is off → FEATURE_DISABLED; anything else is not a command at all (04 §7).
      return GATEWAY_COMMANDS[cmd]
        ? result({ code: "FEATURE_DISABLED", message: "This feature is turned off on this server." })
        : result({ code: "BAD_REQUEST", message: "Unknown command." });
    }
    try {
      await handler(args, { actor: session!.actor, sessionId: session!.id });
      result();
    } catch (err) {
      if (err instanceof AppError) return result({ code: err.code, message: err.message });
      deps.log.error({ err, cmd }, "gateway command failed");
      result({ code: "INTERNAL", message: "Something went wrong on the server." });
    }
  }

  async function onFrame(raw: RawData, isBinary: boolean): Promise<void> {
    if (closed) return;
    if (!spend()) return close(CloseCode.RATE_LIMITED, "too many messages");
    if (isBinary) return close(CloseCode.DECODE_ERROR, "binary frames are not supported");
    let json: unknown;
    try {
      json = JSON.parse(rawToString(raw));
    } catch {
      return close(CloseCode.DECODE_ERROR, "invalid JSON");
    }
    const frame = ClientFrameSchema.safeParse(json);
    if (!frame.success) return close(CloseCode.INVALID_OPCODE, "malformed frame");
    const { op, d } = frame.data;

    if (!session) {
      if (op === Op.IDENTIFY) return identify(d);
      if (op === Op.RESUME) return resume(d);
      return close(CloseCode.NOT_AUTHENTICATED, "identify first");
    }
    switch (op) {
      case Op.HEARTBEAT:
        if (!HeartbeatPayloadSchema.safeParse(d ?? null).success)
          return close(CloseCode.INVALID_OPCODE, "malformed HEARTBEAT");
        lastHeartbeat = now();
        return sendOp(Op.HEARTBEAT_ACK, null);
      case Op.COMMAND:
        return command(d);
      case Op.IDENTIFY:
      case Op.RESUME:
        return close(CloseCode.ALREADY_AUTHENTICATED, "already authenticated");
      default:
        return close(CloseCode.INVALID_OPCODE, "unknown opcode");
    }
  }

  socket.on("message", (data, isBinary) => {
    queue = queue
      .then(() => onFrame(data, isBinary))
      .catch((err: unknown) => {
        deps.log.error({ err }, "gateway frame handler crashed");
        close(CloseCode.UNKNOWN_ERROR, "internal error");
      });
  });
  socket.on("close", () => {
    closed = true;
    clearTimeout(identifyTimer);
    clearInterval(heartbeatTimer);
    if (session && session.conn === conn) {
      session.conn = null;
      session.detachedAt = now();
    }
  });
  socket.on("error", (err) => deps.log.debug({ err }, "gateway socket error"));

  if (clientVersion !== undefined && clientVersion !== String(API_VERSION)) {
    // Sent as a frame first so the client can show an upgrade message, then closed (07 §6).
    const hello: HelloPayload = { heartbeatIntervalMs: deps.heartbeatIntervalMs, apiVersion: API_VERSION };
    sendOp(Op.HELLO, hello);
    close(CloseCode.CLIENT_TOO_OLD, "unsupported api version");
    return;
  }

  const hello: HelloPayload = { heartbeatIntervalMs: deps.heartbeatIntervalMs, apiVersion: API_VERSION };
  sendOp(Op.HELLO, hello);
  identifyTimer = setTimeout(
    () => close(CloseCode.NOT_AUTHENTICATED, "identify timeout"),
    deps.identifyTimeoutMs,
  );
  identifyTimer.unref();
}

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}
