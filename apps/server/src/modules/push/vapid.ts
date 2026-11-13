// SPDX-License-Identifier: AGPL-3.0-or-later
import { createECDH, hkdfSync } from "node:crypto";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * The instance's VAPID key pair (RFC 8292), derived from `security.instanceSecret` so there is nothing extra to
 * store or back up. Rotating the secret changes the key, which makes browsers' old subscriptions fail with 403/410;
 * clients then subscribe again on their next start.
 */
export function deriveVapidKeys(instanceSecret: string): VapidKeys {
  const ecdh = createECDH("prime256v1");
  const seed = Buffer.from(hkdfSync("sha256", instanceSecret, "tincan", "web-push vapid v1", 32));
  ecdh.setPrivateKey(seed);
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

/** Push services this build will send to. A subscription naming any other host is refused (it would make the server fetch arbitrary URLs). */
export const DEFAULT_PUSH_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
];

export function endpointAllowed(endpoint: string, extraHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return [...DEFAULT_PUSH_HOSTS, ...extraHosts].some((h) => host === h || host.endsWith(`.${h}`));
}
