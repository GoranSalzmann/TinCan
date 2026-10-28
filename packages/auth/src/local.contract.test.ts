// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { runAuthContract } from "./contract.js";
import {
  LocalAuthAdapter,
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  safeEqual,
  verifyPassword,
} from "./index.js";

// Cheap parameters keep the suite fast; production defaults are covered in password tests below.
const fast = { memoryKiB: 1024, timeCost: 1, parallelism: 1 };

runAuthContract("local", async () => {
  const hash = await hashPassword("correct horse battery", fast);
  const adapter = new LocalAuthAdapter({
    params: fast,
    lookup: async (username) => {
      if (username === "ann") return { userId: "U1", username: "ann", passwordHash: hash };
      if (username === "oidc-only") return { userId: "U2", username: "oidc-only", passwordHash: null };
      return null;
    },
  });
  return {
    adapter,
    known: { username: "ann", password: "correct horse battery", userId: "U1" },
    passwordless: "oidc-only",
  };
});

describe("passwords", () => {
  it("hashes as argon2id with the default 64 MiB / 3 iteration parameters and verifies", async () => {
    const hash = await hashPassword("a long enough password");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(await verifyPassword(hash, "a long enough password")).toBe(true);
    expect(await verifyPassword(hash, "a long enough passwore")).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it("flags hashes made with weaker parameters and treats garbage as a mismatch", async () => {
    const weak = await hashPassword("a long enough password", fast);
    expect(needsRehash(weak)).toBe(true);
    expect(await verifyPassword("not a hash", "x")).toBe(false);
  });
});

describe("tokens", () => {
  it("makes 256-bit url-safe tokens and stable SHA-256 hashes", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("compares in constant time across lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
