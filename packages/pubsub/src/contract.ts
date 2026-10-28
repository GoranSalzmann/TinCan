// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLease, releaseLease, type PubSub } from "./port.js";

/**
 * Shared pubsub contract (16 §3). Every adapter must pass this suite; Redis joins post-v1.
 * `advance(ms)` moves the adapter's clock; real-time adapters pass a function that sleeps.
 */
export interface PubSubHarness {
  pubsub: PubSub;
  advance(ms: number): Promise<void>;
  cleanup(): Promise<void>;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

export function runPubSubContract(name: string, make: () => Promise<PubSubHarness>): void {
  describe(`pubsub contract: ${name}`, () => {
    let h: PubSubHarness;
    let ps: PubSub;
    beforeEach(async () => {
      h = await make();
      ps = h.pubsub;
    });
    afterEach(async () => {
      await ps.close();
      await h.cleanup();
    });

    it("delivers published payloads to subscribers of that topic only, as copies", async () => {
      const a: unknown[] = [];
      const b: unknown[] = [];
      ps.subscribe("t1", (p) => a.push(p));
      ps.subscribe("t2", (p) => b.push(p));
      const payload = { n: 1, nested: { x: [1, 2] } };
      await ps.publish("t1", payload);
      await tick();
      expect(a).toEqual([payload]);
      expect(a[0]).not.toBe(payload);
      expect(b).toEqual([]);
    });

    it("stops delivering after unsubscribe", async () => {
      const got: unknown[] = [];
      const off = ps.subscribe("t", (p) => got.push(p));
      await ps.publish("t", 1);
      await tick();
      off();
      await ps.publish("t", 2);
      await tick();
      expect(got).toEqual([1]);
    });

    it("isolates a throwing handler from the publisher and other subscribers", async () => {
      const got: unknown[] = [];
      ps.subscribe("t", () => {
        throw new Error("handler failed");
      });
      ps.subscribe("t", (p) => got.push(p));
      await expect(ps.publish("t", "ok")).resolves.toBeUndefined();
      await tick();
      expect(got).toEqual(["ok"]);
    });

    it("keeps publish order per topic", async () => {
      const got: unknown[] = [];
      ps.subscribe("t", (p) => got.push(p));
      for (let i = 0; i < 20; i++) await ps.publish("t", i);
      await tick();
      expect(got).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });

    describe("kv", () => {
      it("gets, sets, deletes", async () => {
        expect(await ps.kv.get("k")).toBeNull();
        expect(await ps.kv.set("k", "v")).toBe(true);
        expect(await ps.kv.get("k")).toBe("v");
        expect(await ps.kv.del("k")).toBe(true);
        expect(await ps.kv.del("k")).toBe(false);
        expect(await ps.kv.get("k")).toBeNull();
      });

      it("expires keys after their ttl and reports the remaining time", async () => {
        await ps.kv.set("k", "v", { ttlMs: 1000 });
        expect(await ps.kv.get("k")).toBe("v");
        expect(await ps.kv.ttl("k")).toBeLessThanOrEqual(1000);
        await h.advance(1001);
        expect(await ps.kv.get("k")).toBeNull();
        expect(await ps.kv.ttl("k")).toBeNull();
      });

      it("sets only if absent with nx", async () => {
        expect(await ps.kv.set("k", "a", { nx: true })).toBe(true);
        expect(await ps.kv.set("k", "b", { nx: true })).toBe(false);
        expect(await ps.kv.get("k")).toBe("a");
        await ps.kv.set("e", "x", { nx: true, ttlMs: 10 });
        await h.advance(11);
        expect(await ps.kv.set("e", "y", { nx: true })).toBe(true);
      });

      it("increments atomically and applies the ttl only when the key is created", async () => {
        const results = await Promise.all(Array.from({ length: 50 }, () => ps.kv.incr("c", { ttlMs: 1000 })));
        expect([...results].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
        await h.advance(600);
        await ps.kv.incr("c", { ttlMs: 1000 }); // must not extend the window
        await h.advance(450);
        expect(await ps.kv.get("c")).toBeNull();
        expect(await ps.kv.incr("c", { ttlMs: 1000 })).toBe(1);
      });

      it("expire() changes the ttl of an existing key only", async () => {
        expect(await ps.kv.expire("none", 100)).toBe(false);
        await ps.kv.set("k", "v");
        expect(await ps.kv.expire("k", 100)).toBe(true);
        await h.advance(101);
        expect(await ps.kv.get("k")).toBeNull();
      });

      it("keeps sets", async () => {
        expect(await ps.kv.sadd("s", "a", "b", "a")).toBe(2);
        expect((await ps.kv.smembers("s")).sort()).toEqual(["a", "b"]);
        expect(await ps.kv.srem("s", "a", "zzz")).toBe(1);
        expect(await ps.kv.smembers("s")).toEqual(["b"]);
        expect(await ps.kv.srem("s", "b")).toBe(1);
        expect(await ps.kv.smembers("s")).toEqual([]);
      });
    });

    describe("leases", () => {
      it("grants a lease to one owner at a time, renews for the holder and releases", async () => {
        expect(await acquireLease(ps.kv, "job", "node-a", 1000)).toBe(true);
        expect(await acquireLease(ps.kv, "job", "node-b", 1000)).toBe(false);
        expect(await acquireLease(ps.kv, "job", "node-a", 1000)).toBe(true);
        await releaseLease(ps.kv, "job", "node-b"); // not the holder: no effect
        expect(await acquireLease(ps.kv, "job", "node-b", 1000)).toBe(false);
        await releaseLease(ps.kv, "job", "node-a");
        expect(await acquireLease(ps.kv, "job", "node-b", 1000)).toBe(true);
      });

      it("passes to another owner after the ttl", async () => {
        expect(await acquireLease(ps.kv, "job", "node-a", 100)).toBe(true);
        await h.advance(101);
        expect(await acquireLease(ps.kv, "job", "node-b", 100)).toBe(true);
      });
    });
  });
}
