// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { GATEWAY_DEFAULTS, Op } from "@tincan/shared";
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

/**
 * Gateway sessions, sequencing and fan-out (05 §5). A session outlives its socket for the replay
 * window so the client can RESUME. Events are filtered per user here; richer visibility filtering
 * (channels, roles) joins in M2.
 */
export class GatewayHub {
  readonly sessions = new Map<string, GatewaySession>();
  readonly commands = new Map<string, GatewayCommandHandler>();
  readonly readyContributors: ReadyContributor[] = [];
  readonly #opts: Required<HubOptions>;

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

  create(actor: Actor): GatewaySession {
    const id = randomBytes(18).toString("base64url");
    const session = new GatewaySession(
      id,
      actor,
      new RingBuffer(this.#opts.ringBufferEvents, this.#opts.ringBufferMs),
    );
    this.sessions.set(id, session);
    return session;
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
