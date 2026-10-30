// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../testing/harness.js";
import { createBackup, prune, readBackupStatus, restoreBackup } from "./backup.js";
import { decryptStream, encryptStream, readPassphrase } from "./backup-crypto.js";
import { nextRun, parseTimeOfDay, runSchedule } from "./backup-schedule.js";

/** Encrypted and scheduled backups (14 §6): the archive format, the passphrase handling and the daily schedule. */

const PASS = "correct horse battery staple";
const CHEAP = { log2N: 10 };

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of it) parts.push(p);
  return Buffer.concat(parts);
}
async function* from(buf: Buffer, step = 7919): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += step) yield buf.subarray(i, i + step);
}
const encrypt = (plain: Buffer, pass = PASS) => collect(encryptStream(from(plain), pass, CHEAP));
const decrypt = (enc: Buffer, pass = PASS) => collect(decryptStream(from(enc, 4001), pass));

describe("backup encryption format", () => {
  const sizes = [0, 1, 100, 64 * 1024 - 1, 64 * 1024, 64 * 1024 + 1, 3 * 64 * 1024, 200_000];
  for (const n of sizes) {
    it(`round-trips ${n} bytes`, async () => {
      const plain = Buffer.alloc(n);
      for (let i = 0; i < n; i++) plain[i] = (i * 31 + 7) & 0xff;
      const enc = await encrypt(plain);
      expect(enc.subarray(0, 4).toString()).toBe("TCBK");
      expect(await decrypt(enc)).toEqual(plain);
    });
  }

  it("does not show the plain bytes and uses a fresh salt every time", async () => {
    const plain = Buffer.from(
      "a very recognisable sentence that must not appear in the archive. ".repeat(40),
    );
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    expect(a.toString("latin1")).not.toContain("recognisable");
    expect(a.equals(b)).toBe(false);
  });

  it("refuses a wrong passphrase", async () => {
    const enc = await encrypt(Buffer.from("secret data".repeat(100)));
    await expect(decrypt(enc, "a different long passphrase")).rejects.toThrow(/passphrase is wrong/);
  });

  it("refuses a changed byte anywhere after the header", async () => {
    const enc = await encrypt(Buffer.alloc(150_000, 3));
    for (const at of [30, 70_000, enc.length - 5]) {
      const bad = Buffer.from(enc);
      bad[at] = bad[at]! ^ 0x01;
      await expect(decrypt(bad), `byte ${at}`).rejects.toThrow();
    }
  });

  it("refuses a cut-off archive, even one cut exactly between two frames", async () => {
    const enc = await encrypt(Buffer.alloc(150_000, 9));
    await expect(decrypt(enc.subarray(0, enc.length - 1))).rejects.toThrow(/cut short|wrong/);
    // Frames are 5 + 65536 + 16 bytes after the 25-byte header: drop everything after the first one.
    const firstFrameEnd = 25 + 5 + 65536 + 16;
    await expect(decrypt(enc.subarray(0, firstFrameEnd))).rejects.toThrow(/cut short/);
  });

  it("refuses reordered frames and data after the end", async () => {
    const enc = await encrypt(Buffer.alloc(150_000, 5));
    const frame = 5 + 65536 + 16;
    const swapped = Buffer.concat([
      enc.subarray(0, 25),
      enc.subarray(25 + frame, 25 + 2 * frame),
      enc.subarray(25, 25 + frame),
      enc.subarray(25 + 2 * frame),
    ]);
    await expect(decrypt(swapped)).rejects.toThrow();
    await expect(decrypt(Buffer.concat([enc, Buffer.from("x")]))).rejects.toThrow(/extra data/);
  });

  it("refuses short passphrases, foreign files and absurd key costs", async () => {
    await expect(collect(encryptStream(from(Buffer.from("x")), "short", CHEAP))).rejects.toThrow(
      /at least 12 characters/,
    );
    await expect(decrypt(Buffer.from("this is a plain text file, not a backup"))).rejects.toThrow(
      /not an encrypted/,
    );
    const enc = await encrypt(Buffer.from("x"));
    const costly = Buffer.from(enc);
    costly[6] = 31;
    await expect(decrypt(costly)).rejects.toThrow(/header is damaged/);
  });
});

describe("passphrase sources", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tincan-pass-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the file first (without its trailing newline), then the file variable, then the value", async () => {
    const f = join(dir, "pass");
    writeFileSync(f, "from a file phrase\r\n");
    expect(await readPassphrase(f, { TINCAN_BACKUP_PASSPHRASE: "from the env" })).toBe("from a file phrase");
    expect(await readPassphrase(undefined, { TINCAN_BACKUP_PASSPHRASE_FILE: f })).toBe("from a file phrase");
    expect(await readPassphrase(undefined, { TINCAN_BACKUP_PASSPHRASE: "from the env" })).toBe(
      "from the env",
    );
    expect(await readPassphrase(undefined, {})).toBeNull();
  });
});

describe("encrypted backups of a real instance", () => {
  let s: TestServer;
  let work: string;
  beforeEach(async () => {
    s = await startTestServer();
    work = mkdtempSync(join(tmpdir(), "tincan-bke-"));
    const owner = await s.setupOwner();
    const form = new FormData();
    form.set(
      "file",
      new Blob(["a file that is easy to recognise in the archive"], { type: "text/plain" }),
      "n.txt",
    );
    expect((await s.request("POST", "/api/v1/uploads", { token: owner, form })).status).toBe(201);
  });
  afterEach(async () => {
    await s.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("encrypts, records its status, and a restore needs the right passphrase and compares the counts", async () => {
    const out = join(work, "out");
    const { path, manifest } = await createBackup(s.config, { outDir: out, passphrase: PASS, crypto: CHEAP });
    expect(path.endsWith(".tar.gz.enc")).toBe(true);
    const raw = readFileSync(path);
    expect(raw.subarray(0, 4).toString()).toBe("TCBK");
    expect(raw.toString("latin1")).not.toContain("easy to recognise");
    expect(manifest.stats?.user).toBeGreaterThanOrEqual(1);
    expect(manifest.stats?.attachment).toBe(1);

    const status = await readBackupStatus(out);
    expect(status.encrypted).toBe(true);
    expect(status.error).toBeNull();
    expect(Date.now() - Date.parse(status.lastOkAt!)).toBeLessThan(60_000);

    await expect(restoreBackup(path, join(work, "r0"))).rejects.toThrow(/encrypted/);
    await expect(
      restoreBackup(path, join(work, "r1"), { passphrase: "another long passphrase" }),
    ).rejects.toThrow(/passphrase is wrong/);
    const r = await restoreBackup(path, join(work, "r2"), { passphrase: PASS });
    expect(r.files).toBeGreaterThanOrEqual(1);
    expect(r.stats).toEqual(manifest.stats);
    expect(readFileSync(join(work, "r2", "data", "app.db")).length).toBeGreaterThan(0);
  });

  it("keeps the newest N of plain and encrypted archives alike", async () => {
    const out = join(work, "out");
    for (const [i, pass] of [undefined, PASS, undefined, PASS].entries()) {
      await createBackup(s.config, {
        outDir: out,
        ...(pass ? { passphrase: pass, crypto: CHEAP } : {}),
        now: () => new Date(Date.UTC(2026, 9, 20 + i, 3, 30)),
      });
    }
    expect(readdirSync(out).filter((n) => n.startsWith("tincan-backup-"))).toHaveLength(4);
    await prune(out, 2);
    expect(readdirSync(out).filter((n) => n.startsWith("tincan-backup-"))).toEqual([
      "tincan-backup-2026-10-22T03-30-00Z.tar.gz",
      "tincan-backup-2026-10-23T03-30-00Z.tar.gz.enc",
    ]);
  });

  it("writes down a failed run, and a later success clears it", async () => {
    const out = join(work, "out");
    mkdirSync(out, { recursive: true });
    await expect(
      createBackup(s.config, { outDir: out, passphrase: PASS, crypto: { log2N: 40 } }),
    ).rejects.toThrow();
    const failed = await readBackupStatus(out);
    expect(failed.lastOkAt).toBeNull();
    expect(failed.error?.message).toBeTruthy();
    expect(readdirSync(out).filter((n) => n.startsWith("tincan-backup-"))).toHaveLength(0);

    await createBackup(s.config, { outDir: out, now: () => new Date(Date.now() + 1000) });
    const ok = await readBackupStatus(out);
    expect(ok.error).toBeNull();
    expect(ok.lastOkAt).not.toBeNull();
    expect(ok.encrypted).toBe(false);
  });

  it("says there is no backup yet for an empty directory", async () => {
    expect(await readBackupStatus(join(work, "nothing"))).toEqual({
      lastOkAt: null,
      error: null,
      file: null,
      encrypted: null,
    });
  });
});

describe("the daily schedule", () => {
  it("parses a time of day and refuses nonsense", () => {
    expect(parseTimeOfDay("03:30")).toEqual({ hour: 3, minute: 30 });
    expect(parseTimeOfDay("3:05")).toEqual({ hour: 3, minute: 5 });
    for (const bad of ["24:00", "12:60", "noon", "0330", ""])
      expect(() => parseTimeOfDay(bad)).toThrow(/03:30/);
  });

  it("picks today when the time is still ahead and tomorrow when it has passed (strictly after now)", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 29, h, m, 0, 0);
    expect(nextRun(at(1), "03:30")).toEqual(at(3, 30));
    expect(nextRun(at(3, 30), "03:30")).toEqual(new Date(2026, 9, 30, 3, 30, 0, 0));
    expect(nextRun(at(23, 59), "03:30")).toEqual(new Date(2026, 9, 30, 3, 30, 0, 0));
  });

  it("runs once per day, survives a failing run, and stops on abort", async () => {
    let clock = new Date(2026, 9, 29, 2, 0, 0, 0);
    const stop = new AbortController();
    const logs: string[] = [];
    let runs = 0;
    await runSchedule({
      at: "03:30",
      now: () => clock,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
      run: async () => {
        runs++;
        if (runs === 1) throw new Error("disk full");
        if (runs === 3) stop.abort();
      },
      log: (l) => logs.push(l),
      signal: stop.signal,
    });
    expect(runs).toBe(3);
    expect(logs.some((l) => l.includes("Backup failed: disk full"))).toBe(true);
    // 29 Oct 03:30, 30 Oct 03:30, 31 Oct 03:30: one run a day.
    expect(clock).toEqual(new Date(2026, 9, 31, 3, 30, 0, 0));
  });
});
