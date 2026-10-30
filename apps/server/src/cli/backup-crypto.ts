// SPDX-License-Identifier: AGPL-3.0-or-later
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { AppError } from "@tincan/shared";

/**
 * Encrypted backups (14 §6). The plain archive is a `.tar.gz`; this wraps its bytes in an authenticated stream:
 *
 *   header   "TCBK" · version(1) · kdf(1 = scrypt) · log2N · r · p · salt(16)                    (25 bytes)
 *   frames   flag(1: 1 = last) · length(4, big endian) · ciphertext · tag(16), as many as needed
 *
 * AES-256-GCM, a key from scrypt over the Host's passphrase, a fresh random salt per archive. Every frame has its own
 * nonce (the frame counter) and authenticates the header, its counter and the "last" flag, so a frame cannot be
 * moved, repeated, dropped from the middle or cut off the end without the tag failing; an archive that ends before
 * a verified last frame is refused. Losing the passphrase loses the backup: there is no recovery.
 */

const MAGIC = Buffer.from("TCBK");
const VERSION = 1;
const KDF_SCRYPT = 1;
const HEADER_LENGTH = 25;
const FRAME_BYTES = 64 * 1024;
const TAG_BYTES = 16;
/** The cost used for new archives: about 128 MiB of memory and a fraction of a second. */
export const DEFAULT_LOG2N = 17;
/** What a reader accepts, so a crafted header cannot ask for gigabytes of memory. */
const MAX_LOG2N = 20;
const MIN_PASSPHRASE = 12;

export const WRONG_KEY =
  "The passphrase is wrong, or the backup is damaged. There is no way to tell which; try the passphrase again.";

export interface EncryptOptions {
  /** Test hook: a cheaper scrypt cost. */
  log2N?: number;
}

function deriveKey(passphrase: string, salt: Buffer, log2N: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** log2N;
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(passphrase.normalize("NFKC"), "utf8"),
      salt,
      32,
      { N, r, p, maxmem: 128 * N * r + 4 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

const nonce = (index: bigint): Buffer => {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(index, 4);
  return n;
};

const aad = (header: Buffer, index: bigint, last: boolean): Buffer => {
  const a = Buffer.alloc(HEADER_LENGTH + 9);
  header.copy(a);
  a.writeBigUInt64BE(index, HEADER_LENGTH);
  a[HEADER_LENGTH + 8] = last ? 1 : 0;
  return a;
};

export function checkPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE)
    throw new AppError(
      "VALIDATION_FAILED",
      `The backup passphrase needs at least ${MIN_PASSPHRASE} characters (a long phrase is better than a short one with symbols).`,
    );
}

/** True when the file starts with the encrypted-backup header. */
export async function isEncryptedArchive(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, MAGIC.length, 0);
    return bytesRead === MAGIC.length && buf.equals(MAGIC);
  } finally {
    await fh.close();
  }
}

/** Takes the bytes of the plain archive and yields the encrypted ones. */
export async function* encryptStream(
  source: AsyncIterable<Buffer>,
  passphrase: string,
  opts: EncryptOptions = {},
): AsyncGenerator<Buffer> {
  checkPassphrase(passphrase);
  const log2N = opts.log2N ?? DEFAULT_LOG2N;
  const salt = randomBytes(16);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION, KDF_SCRYPT, log2N, 8, 1]), salt]);
  const key = await deriveKey(passphrase, salt, log2N, 8, 1);
  yield header;

  let index = 0n;
  const seal = (plain: Buffer, last: boolean): Buffer => {
    const cipher = createCipheriv("aes-256-gcm", key, nonce(index), { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(header, index, last));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const frameHead = Buffer.alloc(5);
    frameHead[0] = last ? 1 : 0;
    frameHead.writeUInt32BE(ct.length, 1);
    index++;
    return Buffer.concat([frameHead, ct, cipher.getAuthTag()]);
  };

  // One frame is held back until the next bytes arrive, so the last one can carry the "last" flag.
  let pending: Buffer = Buffer.alloc(0);
  let held: Buffer | null = null;
  for await (const chunk of source) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= FRAME_BYTES) {
      if (held) yield seal(held, false);
      held = pending.subarray(0, FRAME_BYTES);
      pending = pending.subarray(FRAME_BYTES);
    }
  }
  if (pending.length > 0) {
    if (held) yield seal(held, false);
    held = pending;
  }
  yield seal(held ?? Buffer.alloc(0), true);
}

/** Takes the encrypted bytes and yields the plain archive. Throws before yielding anything that failed to verify. */
export async function* decryptStream(
  source: AsyncIterable<Buffer>,
  passphrase: string,
): AsyncGenerator<Buffer> {
  let buf: Buffer = Buffer.alloc(0);
  const it = source[Symbol.asyncIterator]();
  /** At least `n` bytes in `buf`, or fewer when the stream ended. */
  async function fill(n: number): Promise<void> {
    while (buf.length < n) {
      const next = await it.next();
      if (next.done) return;
      const chunk: Buffer = next.value;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    }
  }
  const truncated = () =>
    new AppError("VALIDATION_FAILED", "The encrypted backup is cut short; it is damaged or incomplete.");

  await fill(HEADER_LENGTH);
  if (buf.length < HEADER_LENGTH || !buf.subarray(0, 4).equals(MAGIC))
    throw new AppError("VALIDATION_FAILED", "This is not an encrypted Tin Can backup.");
  const header = Buffer.from(buf.subarray(0, HEADER_LENGTH));
  const [version, kdf, log2N, r, p] = [header[4]!, header[5]!, header[6]!, header[7]!, header[8]!];
  if (version !== VERSION || kdf !== KDF_SCRYPT)
    throw new AppError(
      "VALIDATION_FAILED",
      `This encrypted backup uses format ${version}.${kdf}; this version of Tin Can reads 1.1.`,
    );
  if (log2N < 10 || log2N > MAX_LOG2N || r < 1 || r > 16 || p < 1 || p > 4)
    throw new AppError("VALIDATION_FAILED", "The encrypted backup's header is damaged.");
  buf = buf.subarray(HEADER_LENGTH);
  const key = await deriveKey(passphrase, header.subarray(9, 25), log2N, r, p);

  let index = 0n;
  for (;;) {
    await fill(5);
    if (buf.length === 0) throw truncated();
    if (buf.length < 5) throw truncated();
    const last = buf[0] === 1;
    const length = buf.readUInt32BE(1);
    if (length > FRAME_BYTES) throw new AppError("VALIDATION_FAILED", WRONG_KEY);
    await fill(5 + length + TAG_BYTES);
    if (buf.length < 5 + length + TAG_BYTES) throw truncated();
    const ct = buf.subarray(5, 5 + length);
    const tag = buf.subarray(5 + length, 5 + length + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce(index), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(header, index, last));
    decipher.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new AppError("VALIDATION_FAILED", WRONG_KEY);
    }
    buf = buf.subarray(5 + length + TAG_BYTES);
    index++;
    if (plain.length > 0) yield plain;
    if (last) {
      await fill(1);
      if (buf.length > 0)
        throw new AppError("VALIDATION_FAILED", "The encrypted backup has extra data after its end.");
      return;
    }
  }
}

/**
 * The passphrase from `--passphrase-file`, or `TINCAN_BACKUP_PASSPHRASE_FILE`, or `TINCAN_BACKUP_PASSPHRASE`, in
 * that order; null when none is set. A trailing newline in a file is not part of the passphrase.
 */
export async function readPassphrase(
  file: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const path = file ?? env.TINCAN_BACKUP_PASSPHRASE_FILE;
  if (path) return (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  return env.TINCAN_BACKUP_PASSPHRASE ?? null;
}
