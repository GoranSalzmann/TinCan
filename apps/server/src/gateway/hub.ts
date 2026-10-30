// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { CloseCode, GATEWAY_DEFAULTS, Op } from "@tincan/shared";
import type { Actor, GatewayCommandHandler } from "../framework/types.js";
import { RingBuffer } from "./ring.js";

/** What the hub needs from a live socket. */
export interface Connection {
  send(frame: string): void;
  close(code: number, reason: string): void;
}

export class GatewaySession {
  readonly id: string;
  readonly actor: Actor;
  seq = 0;
  readonly ring: RingBuffer;
  conn: Connection | null = null;
  detachedAt: number | null = null;
  /** Channels this session's user may currently see (11 §2.5): the delivery filter of 05 §5. */
  channels: ReadonlySet<string> = new Set();

  constructor(id: string, actor: Actor, ring: RingBuffer) {
    this.id = id;
    this.actor = actor;
    this.ring = ring;
  }
}

export interface HubOptions {
  ringBufferEvents?: number;
  ringBufferMs?: number;
  now?: () => number;
}

export type ReadyContributor = (actor: Actor) => Promise<Record<string, unknown>> | Record<string, unknown>;
export type ChannelAccessProvider = (userId: string) => Promise<ReadonlySet<string>> | ReadonlySet<string>;
export type PresenceListener = (userId: string, online: boolean) => void;

/** A user who loses every socket stays "online" this long, so a page reload does not flicker (07 §4.5). */
const OFFLINE_GRACE_MS = 5_000;

/**
 * Gateway sessions, sequencing and fan-out (05 §5). A session outlives its socket for the replay
 * window so the client can RESUME. Events are filtered per user here; richer visibility filtering
 * (channels, roles) joins in M2.
 */
export class GatewayHub {
  readonly sessions = new Map<string, GatewaySession>();
  readonly commands = new Map<string, GatewayCommandHandler>();
  readonly readyContributors: ReadyContributor[] = [];
  channelAccess: ChannelAccessProvider | null = null;
  readonly presenceListeners: PresenceListener[] = [];
  readonly #opts: Required<HubOptions>;
  readonly #online = new Set<string>();
  readonly #offlineTimers = new Map<string, NodeJS.Timeout>();

  constructor(opts: HubOptions = {}) {
    this.#opts = {
      ringBufferEvents: opts.ringBufferEvents ?? GATEWAY_DEFAULTS.ringBufferEvents,
      ringBufferMs: opts.ringBufferMs ?? GATEWAY_DEFAULTS.ringBufferMs,
      now: opts.now ?? Date.now,
    };
  }

  get replayWindowMs(): number {
    return this.#opts.ringBufferMs;
  }

  /** `channels` is the user's current visibility set, computed by `roles` just before the session is created. */
  create(actor: Actor, channels: ReadonlySet<string> = new Set()): GatewaySession {
    this.#capSessions(actor.userId);
    const id = randomBytes(18).toString("base64url");
    const session = new GatewaySession(
      id,
      actor,
      new RingBuffer(this.#opts.ringBufferEvents, this.#opts.ringBufferMs),
    );
    session.channels = channels;
    this.sessions.set(id, session);
    return session;
  }

  /** Most gateway sessions one member may hold; when a new one starts beyond it, the oldest ends (15 §4.2). */
  maxSessionsPerUser = Number.POSITIVE_INFINITY;

  #capSessions(userId: string): void {
    const mine = [...this.sessions].filter(([, s]) => s.actor.userId === userId);
    // Map order is creation order, so the first ones are the oldest.
    for (const [id, session] of mine.slice(0, Math.max(0, mine.length - this.maxSessionsPerUser + 1))) {
      this.sessions.delete(id);
      session.conn?.close(CloseCode.SESSION_REPLACED, "too many sessions");
      session.conn = null;
    }
  }

  /** Called whenever a socket attaches to a session (IDENTIFY, RESUME). */
  attach(session: GatewaySession, conn: Connection): void {
    session.conn = conn;
    session.detachedAt = null;
    this.#markOnline(session.actor.userId);
  }

  /** Called when a socket leaves a session. The session itself stays for the replay window. */
  detach(session: GatewaySession, conn: Connection): void {
    if (session.conn !== conn) return;
    session.conn = null;
    session.detachedAt = this.#opts.now();
    this.#maybeOffline(session.actor.userId);
  }

  isOnline(userId: string): boolean {
    return this.#online.has(userId);
  }

  onlineUserIds(): string[] {
    return [...this.#online];
  }

  #hasSocket(userId: string): boolean {
    for (const s of this.sessions.values()) if (s.actor.userId === userId && s.conn) return true;
    return false;
  }

  #markOnline(userId: string): void {
    const timer = this.#offlineTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.#offlineTimers.delete(userId);
    }
    if (this.#online.has(userId)) return;
    this.#online.add(userId);
    for (const l of this.presenceListeners) l(userId, true);
  }

  #maybeOffline(userId: string): void {
    if (!this.#online.has(userId) || this.#hasSocket(userId) || this.#offlineTimers.has(userId)) return;
    const timer = setTimeout(() => {
      this.#offlineTimers.delete(userId);
      if (this.#hasSocket(userId) || !this.#online.delete(userId)) return;
      for (const l of this.presenceListeners) l(userId, false);
    }, OFFLINE_GRACE_MS);
    timer.unref();
    this.#offlineTimers.set(userId, timer);
  }

  /** Replaces the visibility set of every session of a user (permission change, channel created or deleted). */
  setChannels(userId: string, channels: ReadonlySet<string>): void {
    for (const s of this.sessions.values()) if (s.actor.userId === userId) s.channels = channels;
  }

  /** Sends to every session whose user can currently see the channel (05 §5 "authorisation on delivery"). */
  dispatchToChannel(channelId: string, t: string, d: unknown, exceptUserId?: string): void {
    for (const session of this.sessions.values()) {
      if (session.actor.userId === exceptUserId) continue;
      if (session.channels.has(channelId)) this.#dispatch(session, t, d);
    }
  }

  dispatchToUsers(userIds: Iterable<string>, t: string, d: unknown): void {
    const wanted = new Set(userIds);
    for (const session of this.sessions.values())
      if (wanted.has(session.actor.userId)) this.#dispatch(session, t, d);
  }

  /** Sequences one event for a session, buffers it for replay, and sends it if the socket is attached. */
  #dispatch(session: GatewaySession, t: string, d: unknown): void {
    const s = ++session.seq;
    const frame = JSON.stringify({ op: Op.DISPATCH, t, s, d });
    session.ring.push(s, frame, this.#opts.now());
    session.conn?.send(frame);
  }

  dispatchToSession(session: GatewaySession, t: string, d: unknown): void {
    this.#dispatch(session, t, d);
  }

  dispatchToUser(userId: string, t: string, d: unknown): void {
    for (const session of this.sessions.values()) {
      if (session.actor.userId === userId) this.#dispatch(session, t, d);
    }
  }

  dispatchToAll(t: string, d: unknown): void {
    for (const session of this.sessions.values()) this.#dispatch(session, t, d);
  }

  /** Ends every gateway session of a login session (logout, revoke, password change). */
  dropByAuthSession(authSessionId: string, closeCode: number, reason: string): void {
    for (const [id, session] of this.sessions) {
      if (session.actor.sessionId !== authSessionId) continue;
      this.sessions.delete(id);
      session.conn?.close(closeCode, reason);
      session.conn = null;
      this.#maybeOffline(session.actor.userId);
    }
  }

  /** Removes sessions that have had no socket for longer than the replay window. */
  sweep(): number {
    const now = this.#opts.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (
        session.conn === null &&
        session.detachedAt !== null &&
        now - session.detachedAt > this.#opts.ringBufferMs
      ) {
        this.sessions.delete(id);
        removed++;
        this.#maybeOffline(session.actor.userId);
      }
    }
    return removed;
  }

  get connected(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.conn) n++;
    return n;
  }

  /** Graceful shutdown: tell clients to reconnect and resume, then close (05 §1). */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.conn?.send(JSON.stringify({ op: Op.RECONNECT, d: null }));
      session.conn?.close(1001, "server shutting down");
      session.conn = null;
      session.detachedAt = this.#opts.now();
    }
  }
}
