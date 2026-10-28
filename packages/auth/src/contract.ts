// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { AuthAdapter } from "./port.js";

/**
 * Shared auth-adapter contract (16 §3): `Identity` mapping and failure modes. OIDC joins with a mock
 * provider after M1. The harness supplies one known account.
 */
export interface AuthHarness {
  adapter: AuthAdapter;
  known: { username: string; password: string; userId: string };
  /** A username that has no password (an OIDC-only account), when the adapter supports that. */
  passwordless?: string;
}

export function runAuthContract(name: string, make: () => Promise<AuthHarness>): void {
  describe(`auth contract: ${name}`, () => {
    it("maps valid credentials to a normalised Identity", async () => {
      const { adapter, known } = await make();
      const id = await adapter.authenticate({ username: known.username, password: known.password });
      expect(id).toEqual({ provider: adapter.kind, subject: known.userId, username: known.username });
    });

    it("returns null, never throws, for a wrong password, unknown user and malformed input", async () => {
      const { adapter, known } = await make();
      expect(
        await adapter.authenticate({ username: known.username, password: "not the password" }),
      ).toBeNull();
      expect(await adapter.authenticate({ username: "nobody-here", password: known.password })).toBeNull();
      for (const bad of [null, undefined, 42, "x", {}, { username: 1, password: 2 }, { username: "a" }]) {
        expect(await adapter.authenticate(bad)).toBeNull();
      }
    });

    it("refuses an account without a password", async (ctx) => {
      const { adapter, passwordless } = await make();
      if (!passwordless) return ctx.skip();
      expect(await adapter.authenticate({ username: passwordless, password: "anything at all" })).toBeNull();
    });
  });
}
