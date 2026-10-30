// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Writable } from "node:stream";

/**
 * A small ustar reader and writer, so a backup is an ordinary `.tar.gz` that `tar -tzf` can list and any host can
 * open without Tin Can, and no archive library has to be trusted with the Host's data (15 §4.8). Regular files and
 * directories only; names up to 255 bytes (prefix + name); sizes up to 8 GiB per entry.
 */

const BLOCK = 512;
const MAX_ENTRY = 8 * 1024 ** 3 - 1;

export interface TarFile {
  /** `/`-separated, relative, no `..`. */
  path: string;
  size: number;
  mode: number;
  mtimeSec: number;
  /** Absolute path to read the bytes from. */
  source: string;
  /** Called with the SHA-256 (hex) of exactly the bytes that went into the archive. */
  onDone?: (sha256: string) => void;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function splitName(path: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { name: path, prefix: "" };
  if (bytes > 255) throw new Error(`archive path too long: ${path.slice(0, 60)}…`);
  // Split at a slash so the name fits in 100 bytes and the prefix in 155.
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`archive path cannot be split: ${path.slice(0, 60)}…`);
}

function header(path: string, size: number, mode: number, mtimeSec: number, type: "0" | "5"): Buffer {
  if (size > MAX_ENTRY) throw new Error(`${path} is larger than 8 GiB, which the archive format cannot hold`);
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(path);
  h.write(name, 0, "utf8");
  h.write(octal(mode, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(mtimeSec, 12), 136, "ascii");
  h.write("        ", 148, "ascii"); // checksum placeholder: eight spaces
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

/** Entries as a stream of tar blocks. `bytes` entries are small in-memory files (the manifest). */
export async function* packTar(
  files: AsyncIterable<TarFile | { path: string; bytes: Buffer; mode?: number }>,
): AsyncGenerator<Buffer> {
  const now = Math.floor(Date.now() / 1000);
  for await (const f of files) {
    if ("bytes" in f) {
      yield header(f.path, f.bytes.length, f.mode ?? 0o600, now, "0");
      yield f.bytes;
      const pad = (BLOCK - (f.bytes.length % BLOCK)) % BLOCK;
      if (pad) yield Buffer.alloc(pad);
      continue;
    }
    yield header(f.path, f.size, f.mode, f.mtimeSec, "0");
    let sent = 0;
    const hash = createHash("sha256");
    if (f.size > 0) {
      for await (const chunk of createReadStream(f.source, { start: 0, end: f.size - 1 })) {
        sent += (chunk as Buffer).length;
        hash.update(chunk as Buffer);
        yield chunk as Buffer;
      }
    }
    if (sent !== f.size)
      throw new Error(`${f.path} changed while it was being read (${sent} of ${f.size} bytes)`);
    f.onDone?.(hash.digest("hex"));
    const pad = (BLOCK - (f.size % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2); // end of archive
}

export interface TarHeader {
  path: string;
  size: number;
  mode: number;
  type: "file" | "dir";
}

/** Safe relative archive path, or null. Rejects absolute paths, `..`, backslashes, drive letters and NULs. */
export function safeArchivePath(p: string): string | null {
  if (p === "" || p.startsWith("/") || p.includes("\\") || p.includes("\0") || /^[A-Za-z]:/.test(p))
    return null;
  const parts = p.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === ".." || s === ".")) return null;
  return parts.join("/");
}

/**
 * Reads a tar stream. `open` is called per file and returns where its bytes go, or null to skip them.
 * Throws on anything that is not a regular file or directory, on a bad checksum and on an unsafe path.
 */
export async function extractTar(
  input: AsyncIterable<Buffer>,
  open: (h: TarHeader) => Promise<Writable | null>,
): Promise<void> {
  const it = input[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  let ended = false;

  async function fill(): Promise<boolean> {
    if (ended) return false;
    const r = await it.next();
    if (r.done) {
      ended = true;
      return false;
    }
    pending = pending.length ? Buffer.concat([pending, r.value]) : r.value;
    return true;
  }
  async function take(n: number): Promise<Buffer | null> {
    while (pending.length < n) if (!(await fill())) return null;
    const out = pending.subarray(0, n);
    pending = pending.subarray(n);
    return out;
  }

  for (;;) {
    const h = await take(BLOCK);
    if (!h) throw new Error("the archive ends in the middle of an entry (truncated?)");
    if (h.every((b) => b === 0)) return; // end marker
    const stored = Number.parseInt(h.toString("ascii", 148, 156).replace(/\0.*$/, "").trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (stored !== sum) throw new Error("the archive is damaged (header checksum mismatch)");
    const name = h.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(h.toString("ascii", 124, 136).replace(/\0.*$/, "").trim() || "0", 8);
    const mode = Number.parseInt(h.toString("ascii", 100, 108).replace(/\0.*$/, "").trim() || "0", 8);
    const typeflag = String.fromCharCode(h[156] || 48);
    const path = safeArchivePath(rawPath);
    if (!path) throw new Error(`the archive holds an unsafe path: ${JSON.stringify(rawPath.slice(0, 80))}`);
    if (typeflag !== "0" && typeflag !== "5")
      throw new Error(
        `the archive holds an entry of type ${JSON.stringify(typeflag)} (${path}), which is not supported`,
      );
    const type = typeflag === "5" ? "dir" : "file";
    const sink = await open({ path, size, mode, type });
    let left = type === "dir" ? 0 : size;
    while (left > 0) {
      if (pending.length === 0 && !(await fill())) throw new Error(`the archive ends inside ${path}`);
      const part = pending.subarray(0, Math.min(left, pending.length));
      pending = pending.subarray(part.length);
      left -= part.length;
      if (sink && !sink.write(part)) await new Promise<void>((r) => sink.once("drain", r));
    }
    if (sink)
      await new Promise<void>((resolve, reject) =>
        sink.end((e?: Error | null) => (e ? reject(e) : resolve())),
      );
    const pad = type === "dir" ? 0 : (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad && !(await take(pad))) throw new Error("the archive ends in the middle of an entry (truncated?)");
  }
}
