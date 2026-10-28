// SPDX-License-Identifier: AGPL-3.0-or-later

/** Normalised external identity (05 §3.4). `accounts` maps it to a local user. */
export interface Identity {
  provider: string;
  subject: string;
  username?: string;
  email?: string;
}

export interface PasswordCredentials {
  username: string;
  password: string;
}

/**
 * Auth port. Adapters only answer "who is this?"; sessions are always created and stored by
 * `accounts`, independent of the adapter. OIDC (begin/callback) joins this port after M1.
 */
export interface AuthAdapter {
  readonly kind: "local" | "oidc";
  authenticate(input: unknown): Promise<Identity | null>;
}
