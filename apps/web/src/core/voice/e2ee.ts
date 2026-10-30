// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExternalE2EEKeyProvider, isE2EESupported } from "livekit-client";

/** Whether this browser can do frame-level encryption (insertable streams or script transforms, 10 §3). */
export function e2eeSupported(): boolean {
  try {
    return isE2EESupported();
  } catch {
    return false;
  }
}

export function decodeKey(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Shared-key provider that sets a key at an explicit index (10 §4.1). `ExternalE2EEKeyProvider.setKey` always writes
 * slot 0, which would drop the previous key at the moment of a rotation; with indexes the receiver keeps the last
 * keys in its keyring and frames in flight still decrypt, and a late joiner's index agrees with everyone else's.
 */
export class RoomKeyProvider extends ExternalE2EEKeyProvider {
  async setKeyAt(key: ArrayBuffer, index: number): Promise<void> {
    const material = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveBits", "deriveKey"]);
    this.onSetEncryptionKey(material, undefined, index);
  }
}

export function createE2eeWorker(): Worker {
  return new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" });
}
