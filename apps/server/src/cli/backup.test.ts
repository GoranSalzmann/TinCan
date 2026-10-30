// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boot, type RunningApp } from "../boot.js";
import { parseCoreConfig } from "../config/load.js";
import type { CoreConfig } from "../config/schema.js";
import { OWNER, startTestServer, type TestServer } from "../testing/harness.js";
import { ALL_MODULES } from "../modules/index.js";
import { createBackup, prune, redactConfig, restoreBackup } from "./backup.js";

/**
 * Backup and restore (14 §6, 16 §7): a running instance with a member, a message and an upload is backed up while it is
 * up, restored into an empty directory, and a second server started on the restored data shows the same things.
 */

let s: TestServer;
let work: string;
let confDir: string;
const api = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
});
const UPLOAD = Buffer.from("not really a picture, but bytes that must survive the round trip\n".repeat(50));

beforeEach(async () => {
  s = await startTestServer();
  work = mkdtempSync(join(tmpdir(), "tincan-bk-"));
  confDir = join(work, "deploy");
  mkdirSync(confDir);
  writeFileSync(
    join(confDir, "config.yaml"),
    "# kept comment\nsecurity:\n  instanceSecret: super-secret-value-that-must-not-leak-0123456789\nlivekit:\n  url: wss://x/livekit\n  apiKey: KEYKEYKEY\n  apiSecret: SECRETSECRET\nlog: { level: info }\n",
  );
  writeFileSync(
    join(confDir, ".env"),
    "TINCAN_SECURITY__INSTANCE_SECRET=super-secret-value-that-must-not-leak-0123456789\n",
  );
  writeFileSync(join(confDir, "docker-compose.yml"), "name: tincan\n");
  writeFileSync(join(confDir, "Caddyfile"), "example.test {}\n");
  writeFileSync(join(confDir, "livekit.yaml"), "keys:\n  KEYKEYKEY: SECRETSECRET\n");
});
afterEach(async () => {
  await s.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function populate() {
  const owner = await s.setupOwner();
  const ann = await s.register("ann");
  const general = ((await api(owner).get("/channels")).body.channels as { id: string; type: string }[]).find(
    (c) => c.type === "text",
  )!.id;
  const form = new FormData();
  form.set("file", new Blob([UPLOAD], { type: "text/plain" }), "notes.txt");
  const up = await s.request("POST", "/api/v1/uploads", { token: ann.token, form });
  expect(up.status).toBe(201);
  const msg = await api(ann.token).post(`/channels/${general}/messages`, {
    content: "hello from before the backup",
    attachmentIds: [up.body.id],
  });
  expect(msg.status).toBe(201);
  return {
    owner,
    ann,
    general,
    messageId: msg.body.id as string,
    fileUrl: `/api/v1/files/${msg.body.attachments[0].id as string}/notes.txt`,
  };
}

describe("backup and restore", () => {
  it("backs up a running instance, restores it elsewhere, and a server on the restored data matches", async () => {
    const before = await populate();
    const out = join(work, "out");
    const { path, manifest } = await createBackup(s.config, { outDir: out, configDir: confDir });

    // A plain gzip'd tar: the gzip layer is valid and the manifest names every other entry.
    expect(gunzipSync(readFileSync(path)).length).toBeGreaterThan(1024);
    expect(manifest.format).toBe(1);
    expect(manifest.secretsIncluded).toBe(false);
    expect(manifest.schema.accounts).toBeGreaterThanOrEqual(1);
    const names = manifest.entries.map((e) => e.path);
    expect(names).toContain("db/app.db");
    expect(names.filter((n) => n.startsWith("files/")).length).toBeGreaterThanOrEqual(1);
    expect(names).toEqual(
      expect.arrayContaining(["config/config.yaml", "config/docker-compose.yml", "config/Caddyfile"]),
    );
    // Secrets stay out unless asked for.
    expect(names).not.toContain("config/.env");
    expect(names).not.toContain("config/livekit.yaml");
    expect(gunzipSync(readFileSync(path)).toString("latin1")).not.toContain("super-secret-value");
    expect(gunzipSync(readFileSync(path)).toString("latin1")).not.toContain("SECRETSECRET");

    const into = join(work, "restored");
    const r = await restoreBackup(path, into);
    expect(r.warnings.join(" ")).toMatch(/no secrets/);
    expect(existsSync(join(into, "data", "app.db"))).toBe(true);
    expect(readFileSync(join(into, "config.yaml"), "utf8")).toContain("# kept comment");
    expect(readFileSync(join(into, "config.yaml"), "utf8")).toContain("REDACTED");
    expect(existsSync(join(into, ".env"))).toBe(false);

    // A second server on the restored data (same instance secret, as the Host's .env would supply).
    const cfg: CoreConfig = parseCoreConfig({
      security: { instanceSecret: s.config.security.instanceSecret },
      instance: { name: "Test Place", publicUrl: "http://localhost" },
      dataDir: join(into, "data"),
      adapters: {
        database: { kind: "sqlite", path: join(into, "data", "app.db") },
        storage: { kind: "local", path: join(into, "data", "files") },
      },
      server: { host: "127.0.0.1", port: 0 },
      log: { level: "silent" },
      modules: { accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } } },
    });
    let app: RunningApp | undefined;
    try {
      app = await boot({ config: cfg });
      const base = app.address!;
      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: OWNER.username, password: OWNER.password }),
      });
      expect(login.status).toBe(200);
      const { token } = (await login.json()) as { token: string };
      const get = async (path: string) => {
        const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
        return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
      };
      const members = JSON.parse((await get("/api/v1/members")).bytes.toString()) as {
        items: { username: string }[];
      };
      expect(members.items.map((m) => m.username).sort()).toEqual(["ann", OWNER.username].sort());
      const list = JSON.parse(
        (await get(`/api/v1/channels/${before.general}/messages`)).bytes.toString(),
      ) as {
        id: string;
        content: string;
      }[];
      expect(list.find((m) => m.id === before.messageId)?.content).toBe("hello from before the backup");
      const file = await get(before.fileUrl);
      expect(file.status).toBe(200);
      expect(createHash("sha256").update(file.bytes).digest("hex")).toBe(
        createHash("sha256").update(UPLOAD).digest("hex"),
      );
    } finally {
      await app?.close();
    }
  });

  it("includes the secrets only when asked, and says so", async () => {
    await populate();
    const { manifest, path } = await createBackup(s.config, {
      outDir: join(work, "out"),
      configDir: confDir,
      includeSecrets: true,
    });
    expect(manifest.secretsIncluded).toBe(true);
    expect(manifest.entries.map((e) => e.path)).toEqual(
      expect.arrayContaining(["config/.env", "config/livekit.yaml"]),
    );
    const r = await restoreBackup(path, join(work, "restored"));
    expect(r.warnings.join(" ")).not.toMatch(/no secrets/);
    expect(readFileSync(join(work, "restored", ".env"), "utf8")).toContain("super-secret-value");
    expect(readFileSync(join(work, "restored", "config.yaml"), "utf8")).toContain("SECRETSECRET");
  });

  it("refuses a damaged archive, a truncated one, and a target that is not empty", async () => {
    await populate();
    const { path } = await createBackup(s.config, { outDir: join(work, "out") });
    const bytes = readFileSync(path);

    const truncated = join(work, "truncated.tar.gz");
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(restoreBackup(truncated, join(work, "r1"))).rejects.toThrow();

    // Flip a byte inside the (uncompressed) database: gzip is rewritten so only our checksum can notice.
    const raw = gunzipSync(bytes);
    const at = raw.indexOf(Buffer.from("SQLite format 3")) + 2000;
    raw[at] = raw[at]! ^ 0xff;
    const { gzipSync } = await import("node:zlib");
    const tampered = join(work, "tampered.tar.gz");
    writeFileSync(tampered, gzipSync(raw));
    await expect(restoreBackup(tampered, join(work, "r2"))).rejects.toThrow(/checksum|damaged|integrity/i);

    mkdirSync(join(work, "full"));
    writeFileSync(join(work, "full", "x"), "x");
    await expect(restoreBackup(path, join(work, "full"))).rejects.toThrow(/not empty/);
    // A failed restore leaves nothing half-written behind.
    expect(existsSync(join(work, "r2", "data"))).toBe(false);
  });

  it("refuses unsafe paths in an archive", async () => {
    const { packTar } = await import("./tar.js");
    const { gzipSync } = await import("node:zlib");
    const chunks: Buffer[] = [];
    for await (const c of packTar(
      (async function* () {
        yield { path: "../escape.txt", bytes: Buffer.from("x") };
      })(),
    ))
      chunks.push(c);
    const evil = join(work, "evil.tar.gz");
    writeFileSync(evil, gzipSync(Buffer.concat(chunks)));
    await expect(restoreBackup(evil, join(work, "r3"))).rejects.toThrow(/unsafe path/);
  });

  it("keeps the newest N backups", async () => {
    const out = join(work, "out");
    mkdirSync(out);
    for (const d of ["2026-01-01T00-00-00Z", "2026-01-02T00-00-00Z", "2026-01-03T00-00-00Z"])
      writeFileSync(join(out, `tincan-backup-${d}.tar.gz`), "x");
    writeFileSync(join(out, "notes.txt"), "keep me");
    const removed = await prune(out, 2);
    expect(removed).toEqual(["tincan-backup-2026-01-01T00-00-00Z.tar.gz"]);
    expect(readdirSync(out).sort()).toEqual([
      "notes.txt",
      "tincan-backup-2026-01-02T00-00-00Z.tar.gz",
      "tincan-backup-2026-01-03T00-00-00Z.tar.gz",
    ]);
  });

  it("blanks secret-looking values in config.yaml and keeps comments", () => {
    const out = redactConfig(
      "# note\nsecurity:\n  instanceSecret: abc\nmodules:\n  voice: { e2ee: { enabled: true } }\n  x:\n    password: p\n",
    );
    expect(out).toContain("# note");
    expect(out).toContain("instanceSecret: REDACTED");
    expect(out).toContain("password: REDACTED");
    expect(out).toContain("enabled: true");
  });
});

describe("the pre-migration backup (14 §7, 06 §8)", () => {
  function config(dir: string): CoreConfig {
    return parseCoreConfig({
      security: { instanceSecret: "upgrade-test-secret-".padEnd(40, "x") },
      instance: { name: "Upgrade", publicUrl: "http://localhost" },
      dataDir: dir,
      adapters: {
        database: { kind: "sqlite", path: join(dir, "app.db") },
        storage: { kind: "local", path: join(dir, "files") },
      },
      server: { host: "127.0.0.1", port: 0 },
      log: { level: "silent" },
      modules: { accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } } },
    });
  }

  it("snapshots the database before an upgrade applies migrations, keeps data readable, and prunes old ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tincan-upg-"));
    try {
      // "Old release": the moderation module (new in M5) is not part of the build yet.
      const oldModules = ALL_MODULES.filter((m) => m.id !== "moderation" && m.id !== "voice");
      const first = await boot({ config: config(dir), modules: oldModules });
      const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
      const res = await fetch(`${first.address}/api/v1/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...OWNER, instanceName: "Friends" }),
      });
      expect(res.status).toBe(200);
      await first.close();
      expect(existsSync(join(dir, "backups"))).toBe(false); // a fresh database needs no backup

      // Old snapshots from earlier upgrades.
      mkdirSync(join(dir, "backups"), { recursive: true });
      for (let i = 1; i <= 6; i++)
        writeFileSync(join(dir, "backups", `pre-migrate-2026-01-0${i}T00-00-00-000Z.db`), "x");

      // "New release": boots on the old database and has migrations to apply.
      const second = await boot({
        config: config(dir),
        modules: ALL_MODULES.filter((m) => m.id !== "voice"),
      });
      await second.close();
      const backups = readdirSync(join(dir, "backups")).filter((n) => n.startsWith("pre-migrate-"));
      expect(backups.length).toBe(5);
      const newest = backups.sort().at(-1)!;
      expect(newest).not.toMatch(/2026-01-0/);

      // The snapshot is the database as it was before the upgrade: it opens, has the owner, and lacks the new tables.
      const { openSqlite, sql } = await import("@tincan/db");
      const snap = await openSqlite({ path: join(dir, "backups", newest) });
      try {
        const users = await sql<{ n: number }>`SELECT count(*) AS n FROM user`.execute(snap.query);
        expect(users.rows[0]!.n).toBe(1);
        const t = await sql<{
          n: number;
        }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'audit_log'`.execute(snap.query);
        expect(t.rows[0]!.n).toBe(0);
      } finally {
        await snap.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
