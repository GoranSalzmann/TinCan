// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Readable } from "node:stream";

export interface StorageMeta {
  contentType: string;
  size: number;
}

export interface PutMeta {
  contentType: string;
  /** If given, the stored byte count must equal it, or the put fails and leaves nothing. */
  size?: number;
}

export interface GetOptions {
  /** Inclusive byte range, like HTTP. `end` omitted means to the end of the object. */
  range?: { start: number; end?: number };
}

/** Storage port (05 §3.2). */
export interface Storage {
  put(key: string, data: Readable, meta: PutMeta): Promise<void>;
  get(key: string, opts?: GetOptions): Promise<{ stream: Readable; meta: StorageMeta }>;
  delete(key: string): Promise<void>;
  /** `null` means "proxy through the app with session auth" (the local adapter always returns null). */
  signedUrl(key: string, ttlSec: number): Promise<string | null>;
  exists(key: string): Promise<boolean>;
}

export class StorageKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`Invalid storage key ${JSON.stringify(key)}: ${reason}`);
    this.name = "StorageKeyError";
  }
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage key not found: ${JSON.stringify(key)}`);
    this.name = "StorageNotFoundError";
  }
}

export class StorageSizeMismatchError extends Error {
  constructor(expected: number, actual: number) {
    super(`Stored ${actual} bytes but the declared size was ${expected}`);
    this.name = "StorageSizeMismatchError";
  }
}
