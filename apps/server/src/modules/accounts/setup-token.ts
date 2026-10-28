// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeEqual } from "@tincan/auth";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U: easy to read from a log and type
export const SETUP_TOKEN_FILE = "setup-token";

/** `XXXX-XXXX-XXXX-XXXX`, 16 characters of ~4.9 bits: about 78 bits. */
export function generateSetupToken(): string {
  const bytes = randomBytes(16);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

const normalise = (t: string) => t.replace(/[\s-]/g, "").toUpperCase();

export function setupTokenPath(dataDir: string): string {
  return join(dataDir, SETUP_TOKEN_FILE);
}

/** Writes a new token unless one exists. Used by `tincan init` and by the server's first boot (11 §1.4). */
export async function ensureSetupToken(dataDir: string): Promise<{ token: string; created: boolean }> {
  const path = setupTokenPath(dataDir);
  if (existsSync(path)) {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return { token: existing, created: false };
  }
  const token = generateSetupToken();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return { token, created: true };
}

export async function matchesSetupToken(dataDir: string, candidate: string): Promise<boolean> {
  let stored: string;
  try {
    stored = (await readFile(setupTokenPath(dataDir), "utf8")).trim();
  } catch {
    return false;
  }
  return stored !== "" && safeEqual(normalise(stored), normalise(candidate));
}

export async function deleteSetupToken(dataDir: string): Promise<void> {
  await rm(setupTokenPath(dataDir), { force: true });
}
