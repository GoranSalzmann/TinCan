// SPDX-License-Identifier: AGPL-3.0-or-later
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageKeyError, StorageNotFoundError, type Storage } from "./port.js";

/** Shared storage contract (16 §3). Every adapter must pass this suite; S3 joins post-v1. */
export interface StorageHarness {
  storage: Storage;
  cleanup(): Promise<void>;
}

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

const bytes = (s: string) => Readable.from([Buffer.from(s)]);

export function runStorageContract(name: string, make: () => Promise<StorageHarness>): void {
  describe(`storage contract: ${name}`, () => {
    let h: StorageHarness;
    let s: Storage;
    beforeEach(async () => {
      h = await make();
      s = h.storage;
    });
    afterEach(async () => h.cleanup());

    it("puts, gets, checks existence and deletes", async () => {
      expect(await s.exists("att/a1.txt")).toBe(false);
      await s.put("att/a1.txt", bytes("hello world"), { contentType: "text/plain", size: 11 });
      expect(await s.exists("att/a1.txt")).toBe(true);
      const got = await s.get("att/a1.txt");
      expect(got.meta).toEqual({ contentType: "text/plain", size: 11 });
      expect((await read(got.stream)).toString()).toBe("hello world");
      await s.delete("att/a1.txt");
      expect(await s.exists("att/a1.txt")).toBe(false);
      await expect(s.get("att/a1.txt")).rejects.toBeInstanceOf(StorageNotFoundError);
      await expect(s.delete("att/a1.txt")).resolves.toBeUndefined();
    });

    it("overwrites an existing key", async () => {
      await s.put("k1", bytes("one"), { contentType: "text/plain" });
      await s.put("k1", bytes("three"), { contentType: "text/markdown" });
      const got = await s.get("k1");
      expect(got.meta).toEqual({ contentType: "text/markdown", size: 5 });
      expect((await read(got.stream)).toString()).toBe("three");
    });

    it("serves byte ranges", async () => {
      await s.put("r1", bytes("0123456789"), { contentType: "application/octet-stream" });
      const mid = await s.get("r1", { range: { start: 2, end: 5 } });
      expect(mid.meta.size).toBe(4);
      expect((await read(mid.stream)).toString()).toBe("2345");
      const tail = await s.get("r1", { range: { start: 7 } });
      expect((await read(tail.stream)).toString()).toBe("789");
      await expect(s.get("r1", { range: { start: 5, end: 99 } })).rejects.toThrow(RangeError);
    });

    it("rejects a declared size that does not match and stores nothing", async () => {
      await expect(s.put("bad1", bytes("abc"), { contentType: "text/plain", size: 99 })).rejects.toThrow();
      expect(await s.exists("bad1")).toBe(false);
    });

    it("returns null from signedUrl when files are proxied by the app", async () => {
      await s.put("u1", bytes("x"), { contentType: "text/plain" });
      expect(await s.signedUrl("u1", 60)).toBeNull();
    });

    it.each([
      "../escape",
      "a/../../escape",
      "/abs/path",
      "a//b",
      "a\\b",
      "C:\\windows",
      ".hidden",
      "a/.hidden",
      "",
      "a/",
      "name\0nul",
      "x".repeat(600),
      "a/file.meta.json",
      "a b",
    ])("refuses the key %j", async (key) => {
      await expect(s.put(key, bytes("x"), { contentType: "text/plain" })).rejects.toBeInstanceOf(
        StorageKeyError,
      );
      await expect(s.get(key)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(s.exists(key)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(s.delete(key)).rejects.toBeInstanceOf(StorageKeyError);
    });
  });
}
