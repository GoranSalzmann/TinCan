// SPDX-License-Identifier: AGPL-3.0-or-later
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import {
  StorageKeyError,
  StorageNotFoundError,
  StorageSizeMismatchError,
  type GetOptions,
  type PutMeta,
  type Storage,
  type StorageMeta,
} from "./port.js";

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_KEY_LENGTH = 512;
const META_SUFFIX = ".meta.json";

/**
 * Keys are `/`-separated segments of `[A-Za-z0-9._-]`, each starting with an alphanumeric, so `..`,
 * absolute paths, backslashes, drive letters and hidden files cannot be expressed at all.
 */
export function validateKey(key: string): string[] {
  if (typeof key !== "string" || key.length === 0) throw new StorageKeyError(String(key), "empty");
  if (key.length > MAX_KEY_LENGTH) throw new StorageKeyError(key.slice(0, 32), "too long");
  const segments = key.split("/");
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) throw new StorageKeyError(key, `bad segment ${JSON.stringify(seg)}`);
    if (seg.endsWith(META_SUFFIX)) throw new StorageKeyError(key, "reserved suffix");
  }
  return segments;
}

/** Local filesystem adapter (v1): files under a configured directory, sharded by the first key characters. */
export class LocalStorage implements Storage {
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = resolve(rootDir);
  }

  #path(key: string): string {
    const segments = validateKey(key);
    const first = segments[0] ?? "";
    // Shard by the first two characters of the key so no directory grows without bound.
    const shard = first.slice(0, 2).toLowerCase();
    const full = resolve(join(this.#root, shard, ...segments));
    if (!full.startsWith(this.#root + sep)) throw new StorageKeyError(key, "escapes the storage root");
    return full;
  }

  async put(key: string, data: Readable, meta: PutMeta): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(data, counter, createWriteStream(tmp, { flags: "wx" }));
      if (meta.size !== undefined && meta.size !== size) throw new StorageSizeMismatchError(meta.size, size);
      await writeFile(`${path}${META_SUFFIX}`, JSON.stringify({ contentType: meta.contentType, size }));
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      await rm(`${path}${META_SUFFIX}`, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async #meta(key: string, path: string): Promise<StorageMeta> {
    try {
      return JSON.parse(await readFile(`${path}${META_SUFFIX}`, "utf8")) as StorageMeta;
    } catch {
      throw new StorageNotFoundError(key);
    }
  }

  async get(key: string, opts: GetOptions = {}): Promise<{ stream: Readable; meta: StorageMeta }> {
    const path = this.#path(key);
    const meta = await this.#meta(key, path);
    const range = opts.range;
    if (range) {
      const end = range.end ?? meta.size - 1;
      if (range.start < 0 || range.start > end || end >= meta.size) {
        throw new RangeError(`Range ${range.start}-${range.end ?? ""} outside object of ${meta.size} bytes`);
      }
      return {
        stream: createReadStream(path, { start: range.start, end }),
        meta: { contentType: meta.contentType, size: end - range.start + 1 },
      };
    }
    return { stream: createReadStream(path), meta };
  }

  async delete(key: string): Promise<void> {
    const path = this.#path(key);
    await rm(path, { force: true });
    await rm(`${path}${META_SUFFIX}`, { force: true });
  }

  async signedUrl(key: string): Promise<string | null> {
    validateKey(key);
    return null;
  }

  async exists(key: string): Promise<boolean> {
    const path = this.#path(key);
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }
}
