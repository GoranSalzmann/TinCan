// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PubSub } from "@tincan/pubsub";

/**
 * Typed in-process event bus (04 §6). Events are facts, not commands; they live in memory and are
 * lost on a crash, so anything that must happen is also covered by a level-triggered path.
 * Each module adds its events by declaration merging into this interface.
 */
export interface Events {
  "core.ready": Record<string, never>;
  "user.created": { userId: string };
  "user.disabled": { userId: string };
  "session.revoked": { userId: string; sessionId: string };
  "instance.updated": { name: string };
  /** A user became a member of the space (setup, registration). */
  "member.joined": { userId: string };
  "message.created": { messageId: string; channelId: string; authorId: string };
  "message.deleted": { messageId: string; channelId: string };
  "attachment.removed": { attachmentId: string; messageId: string | null; channelId: string | null };
  "channel.created": { channelId: string };
  "channel.updated": { channelId: string };
  "channel.deleted": { channelId: string };
  /** A moderator removed someone (11 §2.6): they are signed out everywhere and leave voice. */
  "member.kicked": { userId: string };
  "member.banned": { userId: string };
  /** Anything may report an auditable fact; `moderation` stores it (11 §3, 06 §3.10). Never include secrets or message text. */
  "audit.record": AuditInput;
  /** An audit entry was stored (by the moderation module); for metrics. */
  "audit.recorded": { action: string };
  /** Anything that can change what someone may do: roles, role assignment, overwrites, channels, timeouts. */
  "permissions.changed": { userIds: string[] | "all"; channelId?: string };
}

export interface AuditInput {
  actorId: string | null;
  /** Dotted name such as `role.update`. */
  action: string;
  targetType?: string;
  targetId?: string;
  reason?: string | undefined;
  data?: Record<string, unknown>;
}

export type EventName = keyof Events;

export interface EmitOptions {
  /** Request that caused the event, so a failed handler's log line names it (18 T34). */
  requestId?: string;
  /** Forward to other nodes over the pubsub port. */
  broadcast?: boolean;
}

export type Handler<K extends EventName> = (
  payload: Events[K],
  meta: { requestId?: string },
) => void | Promise<void>;

export interface EventBus {
  emit<K extends EventName>(name: K, payload: Events[K], opts?: EmitOptions): void;
  on<K extends EventName>(name: K, handler: Handler<K>): () => void;
}

export interface BusDeps {
  log: { error(obj: unknown, msg?: string): void };
  pubsub?: PubSub;
  nodeId?: string;
}

const TOPIC = (name: string) => `bus.${name}`;

export class InProcessEventBus implements EventBus {
  readonly #handlers = new Map<string, Set<Handler<EventName>>>();
  readonly #deps: BusDeps;
  readonly #forwarded = new Set<string>();
  #pending = 0;
  #idle: (() => void)[] = [];
  readonly failures = { count: 0 };

  constructor(deps: BusDeps) {
    this.#deps = deps;
  }

  on<K extends EventName>(name: K, handler: Handler<K>): () => void {
    let set = this.#handlers.get(name);
    if (!set) this.#handlers.set(name, (set = new Set()));
    set.add(handler as Handler<EventName>);
    this.#subscribeRemote(name);
    return () => set.delete(handler as Handler<EventName>);
  }

  emit<K extends EventName>(name: K, payload: Events[K], opts: EmitOptions = {}): void {
    this.#deliver(name, payload, opts.requestId);
    if (opts.broadcast && this.#deps.pubsub) {
      void this.#deps.pubsub
        .publish(TOPIC(name), { from: this.#deps.nodeId, payload, requestId: opts.requestId })
        .catch((err: unknown) => this.#deps.log.error({ err, event: name }, "event broadcast failed"));
    }
  }

  /** Resolves once every handler started so far has finished. For tests and graceful shutdown. */
  async idle(): Promise<void> {
    if (this.#pending === 0) return;
    await new Promise<void>((resolve) => this.#idle.push(resolve));
  }

  #subscribeRemote(name: string): void {
    const ps = this.#deps.pubsub;
    if (!ps || this.#forwarded.has(name)) return;
    this.#forwarded.add(name);
    ps.subscribe(TOPIC(name), (msg) => {
      const m = msg as { from?: string; payload: Events[EventName]; requestId?: string };
      if (m.from !== undefined && m.from === this.#deps.nodeId) return; // our own broadcast, already delivered
      this.#deliver(name as EventName, m.payload, m.requestId);
    });
  }

  #deliver(name: EventName, payload: Events[EventName], requestId: string | undefined): void {
    for (const handler of [...(this.#handlers.get(name) ?? [])]) {
      this.#pending++;
      queueMicrotask(() => {
        void (async () => {
          try {
            await handler(payload, { requestId });
          } catch (err) {
            // A handler failing never fails the publisher: log it, count it (04 §6).
            this.failures.count++;
            this.#deps.log.error({ err, event: name, requestId }, "event handler failed");
          } finally {
            if (--this.#pending === 0) {
              const waiting = this.#idle;
              this.#idle = [];
              for (const w of waiting) w();
            }
          }
        })();
      });
    }
  }
}
