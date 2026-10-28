// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthAdapter, Identity, PasswordCredentials } from "./port.js";
import { DEFAULT_ARGON2, hashPassword, verifyPassword, type Argon2Params } from "./password.js";

export interface StoredCredential {
  userId: string;
  username: string;
  /** Null for accounts that cannot log in with a password (OIDC-only). */
  passwordHash: string | null;
}

export interface LocalAuthOptions {
  /** Looks a credential up by (already normalised) username. Provided by `accounts`; this package never sees the DB. */
  lookup: (username: string) => Promise<StoredCredential | null>;
  params?: Argon2Params;
}

/**
 * Local username + password adapter. Unknown user, wrong password and password-less account all take
 * the same path through one argon2 verification and return the same `null` (11 §1.3).
 */
export class LocalAuthAdapter implements AuthAdapter {
  readonly kind = "local" as const;
  readonly #lookup: LocalAuthOptions["lookup"];
  readonly #params: Argon2Params;
  #dummy: Promise<string> | undefined;

  constructor(opts: LocalAuthOptions) {
    this.#lookup = opts.lookup;
    this.#params = opts.params ?? DEFAULT_ARGON2;
  }

  /** A hash of a random password, made once with the current parameters, to verify against for unknown users. */
  #dummyHash(): Promise<string> {
    this.#dummy ??= hashPassword(`dummy-${Math.random()}-${Date.now()}`, this.#params);
    return this.#dummy;
  }

  async authenticate(input: unknown): Promise<Identity | null> {
    const creds = input as Partial<PasswordCredentials> | null;
    if (!creds || typeof creds.username !== "string" || typeof creds.password !== "string") return null;
    const stored = await this.#lookup(creds.username);
    const hash = stored?.passwordHash ?? (await this.#dummyHash());
    const ok = await verifyPassword(hash, creds.password);
    if (!ok || !stored || stored.passwordHash === null) return null;
    return { provider: "local", subject: stored.userId, username: stored.username };
  }
}
