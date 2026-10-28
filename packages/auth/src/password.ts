// SPDX-License-Identifier: AGPL-3.0-or-later
import argon2 from "argon2";

/**
 * argon2id (11 §1.1). Defaults: 64 MiB, 3 iterations, parallelism 1, tuned toward 150–300 ms on the
 * Host's hardware (`tincan bench-auth` arrives later). Parameters are stored in the hash string, so
 * they can be raised and old hashes upgraded on login.
 */
export interface Argon2Params {
  memoryKiB: number;
  timeCost: number;
  parallelism: number;
}

export const DEFAULT_ARGON2: Argon2Params = { memoryKiB: 64 * 1024, timeCost: 3, parallelism: 1 };

export function hashPassword(password: string, params: Argon2Params = DEFAULT_ARGON2): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: params.memoryKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // malformed hash: treat as a mismatch, never as an error that reveals the account exists
  }
}

/** True when the stored hash was made with weaker parameters than `params` and should be redone on login. */
export function needsRehash(hash: string, params: Argon2Params = DEFAULT_ARGON2): boolean {
  return argon2.needsRehash(hash, {
    memoryCost: params.memoryKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
}
