// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Kv, PubSub, SetOptions, Unsubscribe } from "./port.js";

interface Entry {
  value: string | Set<string>;
  expiresAt: number | null;
}

/** In-process key-value store with TTLs. `now` is injectable so tests control time. */
export class MemoryKv implements Kv {
  readonly #data = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #live(key: string): Entry | undefined {
    const e = this.#data.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= this.#now()) {
      this.#data.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    const e = this.#live(key);
    return typeof e?.value === "string" ? e.value : null;
  }

  async set(key: string, value: string, opts: SetOptions = {}): Promise<boolean> {
    if (opts.nx && this.#live(key)) return false;
    this.#data.set(key, { value, expiresAt: opts.ttlMs === undefined ? null : this.#now() + opts.ttlMs });
    return true;
  }

  async del(key: string): Promise<boolean> {
    const existed = this.#live(key) !== undefined;
    this.#data.delete(key);
    return existed;
  }

  async incr(key: string, opts: { ttlMs?: number } = {}): Promise<number> {
    const e = this.#live(key);
    if (e && typeof e.value !== "string") throw new Error(`kv: ${key} holds a set, not a counter`);
    const next = (e ? Number(e.value) : 0) + 1;
    if (e) {
      e.value = String(next);
    } else {
      this.#data.set(key, {
        value: String(next),
        expiresAt: opts.ttlMs === undefined ? null : this.#now() + opts.ttlMs,
      });
    }
    return next;
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    const e = this.#live(key);
    if (!e) return false;
    e.expiresAt = this.#now() + ttlMs;
    return true;
  }

  async ttl(key: string): Promise<number | null> {
    const e = this.#live(key);
    return e && e.expiresAt !== null ? e.expiresAt - this.#now() : null;
  }

  #set(key: string, create: boolean): Set<string> | undefined {
    const e = this.#live(key);
    if (e) {
      if (typeof e.value === "string") throw new Error(`kv: ${key} holds a string, not a set`);
      return e.value;
    }
    if (!create) return undefined;
    const s = new Set<string>();
    this.#data.set(key, { value: s, expiresAt: null });
    return s;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.#set(key, true)!;
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const s = this.#set(key, false);
    if (!s) return 0;
    let removed = 0;
    for (const m of members) if (s.delete(m)) removed++;
    if (s.size === 0) this.#data.delete(key);
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.#set(key, false) ?? [])];
  }
}

type Handler = (payload: unknown) => void;

/** Memory adapter (v1, single node). Lost on restart. */
export class MemoryPubSub implements PubSub {
  readonly kv: Kv;
  readonly #topics = new Map<string, Set<Handler>>();
  readonly #onHandlerError: (topic: string, err: unknown) => void;

  constructor(opts: { now?: () => number; onHandlerError?: (topic: string, err: unknown) => void } = {}) {
    this.kv = new MemoryKv(opts.now);
    this.#onHandlerError = opts.onHandlerError ?? (() => undefined);
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    // The JSON round trip is the contract: it is what a networked adapter does to the payload.
    const wire = JSON.stringify(payload ?? null);
    for (const handler of [...(this.#topics.get(topic) ?? [])]) {
      queueMicrotask(() => {
        try {
          handler(JSON.parse(wire) as unknown);
        } catch (err) {
          this.#onHandlerError(topic, err);
        }
      });
    }
  }

  subscribe(topic: string, handler: Handler): Unsubscribe {
    let set = this.#topics.get(topic);
    if (!set) this.#topics.set(topic, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.#topics.delete(topic);
    };
  }

  async close(): Promise<void> {
    this.#topics.clear();
  }
}
