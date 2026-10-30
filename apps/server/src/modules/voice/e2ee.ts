// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { E2EE_KEYRING_SIZE, type E2eeKey } from "@tincan/shared";

/**
 * Voice E2EE key derivation (10 §4.1). Nothing here is stored per room: the key follows from the
 * instance secret, a random salt kept in the database, the LiveKit room's SID and the epoch in the room's
 * metadata, so any app node, and the same node after a restart, derives the same key again (18 T27, D4-3).
 */

/** What the app keeps in a LiveKit room's metadata. Not secret: participants can read it. */
export interface RoomE2ee {
  /** Whether the room was created as an encrypted one. Changing it needs a new room. */
  on: boolean;
  epoch: number;
}

export function roomMetadata(m: RoomE2ee): string {
  return JSON.stringify({ e2ee: m });
}

/** Rooms made before E2EE existed have no metadata; they count as unencrypted at epoch 0. */
export function parseRoomMetadata(raw: string | undefined | null): RoomE2ee {
  if (!raw) return { on: false, epoch: 0 };
  try {
    const e = (JSON.parse(raw) as { e2ee?: Partial<RoomE2ee> }).e2ee;
    if (e && typeof e.epoch === "number" && Number.isInteger(e.epoch) && e.epoch >= 0) {
      return { on: e.on === true, epoch: e.epoch };
    }
  } catch {
    /* fall through */
  }
  return { on: false, epoch: 0 };
}

export const keyIndexOf = (epoch: number): number => epoch % E2EE_KEYRING_SIZE;

export class E2eeKeys {
  readonly #instanceSecret: string;
  #salt: string;

  constructor(instanceSecret: string, salt: string) {
    this.#instanceSecret = instanceSecret;
    this.#salt = salt;
  }

  static newSalt(): string {
    return randomBytes(32).toString("hex");
  }

  get salt(): string {
    return this.#salt;
  }

  /** After `tincan e2ee rotate-secret`: every key derived from now on differs from every earlier one. */
  setSalt(salt: string): void {
    this.#salt = salt;
  }

  /** roomKey(epoch) = HKDF-SHA256(ikm, salt = roomSession, info = tincan/e2ee/v1/<channel>/<epoch>). */
  key(channelId: string, roomSid: string, epoch: number): E2eeKey {
    const ikm = createHmac("sha256", this.#instanceSecret).update(this.#salt).digest();
    const raw = hkdfSync("sha256", ikm, roomSid, `tincan/e2ee/v1/${channelId}/${epoch}`, 32);
    return { epoch, keyIndex: keyIndexOf(epoch), key: Buffer.from(raw).toString("base64") };
  }
}
