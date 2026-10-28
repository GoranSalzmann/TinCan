// SPDX-License-Identifier: AGPL-3.0-or-later

export type Unsubscribe = () => void;

export interface SetOptions {
  /** Expire the key after this many milliseconds. */
  ttlMs?: number;
  /** Set only if the key does not exist (lease and one-time-ticket primitive). */
  nx?: boolean;
}

/**
 * Ephemeral shared state for presence, rate limits and leases (05 §3.3). Values are strings so every
 * adapter (memory now, Redis later) behaves alike. Nothing that must survive a restart lives here.
 */
export interface Kv {
  get(key: string): Promise<string | null>;
  /** Returns false only when `nx` was set and the key already existed. */
  set(key: string, value: string, opts?: SetOptions): Promise<boolean>;
  /** Returns whether the key existed. */
  del(key: string): Promise<boolean>;
  /**
   * Atomic increment. `ttlMs` applies only when the call creates the key, so repeated calls inside one
   * window do not extend it (fixed-window rate limits).
   */
  incr(key: string, opts?: { ttlMs?: number }): Promise<number>;
  /** Returns false if the key does not exist. */
  expire(key: string, ttlMs: number): Promise<boolean>;
  /** Remaining time to live in ms; null if the key does not exist or has none. */
  ttl(key: string): Promise<number | null>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
}

export interface PubSub {
  /** Payloads must be JSON-serialisable; subscribers receive a copy. */
  publish(topic: string, payload: unknown): Promise<void>;
  /** A throwing handler never affects the publisher or other subscribers. */
  subscribe(topic: string, handler: (payload: unknown) => void): Unsubscribe;
  readonly kv: Kv;
  close(): Promise<void>;
}

/** Single-runner lease on top of `kv` (05 §7). Returns true if `owner` now holds it. */
export async function acquireLease(kv: Kv, name: string, owner: string, ttlMs: number): Promise<boolean> {
  const key = `lease:${name}`;
  if (await kv.set(key, owner, { nx: true, ttlMs })) return true;
  if ((await kv.get(key)) === owner) {
    await kv.expire(key, ttlMs);
    return true;
  }
  return false;
}

export async function releaseLease(kv: Kv, name: string, owner: string): Promise<void> {
  const key = `lease:${name}`;
  if ((await kv.get(key)) === owner) await kv.del(key);
}
