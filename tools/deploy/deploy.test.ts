// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// deploy/deploy.sh against a fake `docker` and `curl` (tools/deploy/fake-*.sh): the whole sequence of 14 §7 without a
// Docker daemon. Needs a POSIX `sh`, which every CI runner and every Tin Can host has.
const here = dirname(fileURLToPath(import.meta.url));
const posix = (p: string) => p.replace(/\\/g, "/");
const script = posix(join(here, "..", "..", "deploy", "deploy.sh"));
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;

const buildBlock = (target: string) =>
  `    build:\n      context: ../tincan-src\n      dockerfile: deploy/Dockerfile\n      target: ${target}\n`;

const composeFile = (server: string, web: string, build: boolean) => `name: tincan
services:
  tincan:
${build ? buildBlock("server") : ""}    image: ${server}
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # host setting that must survive
  caddy:
${build ? buildBlock("web") : ""}    image: ${web}
  livekit:
    profiles: [voice]
    image: livekit/livekit-server:v1.13.10
  backup:
    profiles: [backup]
    image: ${server}
    command: ["node", "dist/cli.js", "backup", "--daemon"]
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Host = ReturnType<typeof host>;

function host(opts: { build?: boolean; from?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tincan-deploy-test-"));
  dirs.push(root);
  const dir = join(root, "tincan");
  const state = join(root, "state");
  mkdirSync(join(dir, "data", "backups"), { recursive: true });
  mkdirSync(state);
  const from = opts.from ?? "1.0.0";
  const server = opts.build ? "tincan-server" : `ghcr.io/goransalzmann/tincan-server:${from}`;
  const web = opts.build ? "tincan-web" : `ghcr.io/goransalzmann/tincan-web:${from}`;
  writeFileSync(join(dir, "docker-compose.yml"), composeFile(server, web, !!opts.build));
  writeFileSync(
    join(dir, ".env"),
    "HOST_UID=1000\nHOST_GID=1000\nTINCAN_INSTANCE__PUBLIC_URL=https://chat.example.com\nTURN_DOMAIN=turn.example.com\n",
  );
  writeFileSync(join(dir, "data", "app.db"), "original");
  writeFileSync(join(state, "running"), opts.build ? "local" : from);
  writeFileSync(join(state, "running_image"), server);
  return { root, dir, state, compose: () => readFileSync(join(dir, "docker-compose.yml"), "utf8") };
}

function deploy(h: Host, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: posix(h.root),
      TMPDIR: posix(h.root),
      TINCAN_DIR: posix(h.dir),
      FAKE_STATE: posix(h.state),
      DOCKER: `sh ${posix(join(here, "fake-docker.sh"))}`,
      CURL: `sh ${posix(join(here, "fake-curl.sh"))}`,
      PASSPHRASE_FILE: posix(join(h.root, "key")),
      TINCAN_DEPLOY_LOG: posix(join(h.root, "deploy.log")),
      TINCAN_DEPLOY_POLL: "1",
      HEALTH_TIMEOUT: "3",
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const calls = (h: Host) => readFileSync(join(h.state, "calls"), "utf8");
const running = (h: Host) => readFileSync(join(h.state, "running"), "utf8").trim();

describe.skipIf(!hasSh)("deploy/deploy.sh", { timeout: 60_000 }, () => {
  describe("the version argument", () => {
    it.each([
      "",
      "1.0",
      "latest",
      "1.0.1; rm -rf /",
      "1.0.1 && id",
      "$(id)",
      "../1.0.1",
      "1.0.1+build",
      "v",
      "-1.0.1",
    ])("refuses %j before touching anything", (v) => {
      const h = host();
      const r = deploy(h, [v]);
      expect(r.code).toBe(2);
      expect(existsSync(join(h.state, "calls"))).toBe(false);
      expect(h.compose()).toContain("tincan-server:1.0.0");
    });

    it("takes the version from SSH_ORIGINAL_COMMAND, as 'deploy X' or 'X', and nothing else", () => {
      expect(deploy(host(), [], { SSH_ORIGINAL_COMMAND: "deploy 1.0.1" }).code).toBe(0);
      expect(deploy(host(), [], { SSH_ORIGINAL_COMMAND: "1.0.1" }).code).toBe(0);
      const bad = host();
      expect(deploy(bad, [], { SSH_ORIGINAL_COMMAND: "deploy 1.0.1; cat /etc/passwd" }).code).toBe(2);
      expect(deploy(bad, [], { SSH_ORIGINAL_COMMAND: "bash" }).code).toBe(2);
      expect(deploy(bad, [], { SSH_ORIGINAL_COMMAND: "" }).code).toBe(2);
      expect(deploy(bad, [], { SSH_ORIGINAL_COMMAND: "deploy 1.0.1\nid" }).code).toBe(2);
      expect(deploy(bad, [], { SSH_ORIGINAL_COMMAND: "1.0.1\n2.0.0" }).code).toBe(2);
    });

    it("answers 'hash' with the checksum of the script and does nothing else", () => {
      const h = host();
      const r = deploy(h, [], { SSH_ORIGINAL_COMMAND: "hash" });
      expect(r.code).toBe(0);
      expect(r.out.trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(h.state, "calls"))).toBe(false);
    });

    it("accepts a leading v and a prerelease", () => {
      const h = host();
      expect(deploy(h, ["v1.1.0-rc.1"]).code).toBe(0);
      expect(h.compose()).toContain("tincan-server:1.1.0-rc.1");
    });
  });

  it("deploys: backup first and verified, pull, only the image lines change, doctor runs", () => {
    const h = host();
    const r = deploy(h, ["1.0.1"]);
    expect(r.out).toContain("Deployed 1.0.1");
    expect(r.code).toBe(0);
    const c = calls(h);
    expect(c.indexOf("cli.js backup")).toBeGreaterThan(-1);
    expect(c.indexOf("cli.js backup")).toBeLessThan(c.indexOf("cli.js restore"));
    expect(c.indexOf("cli.js restore")).toBeLessThan(c.indexOf("docker pull"));
    expect(c.indexOf("docker pull")).toBeLessThan(c.indexOf("up -d"));
    expect(c).toContain("--profile voice --profile dashboards --profile backup");
    expect(c).toContain("ghcr.io/goransalzmann/tincan-web:1.0.1");
    const compose = h.compose();
    expect(compose.match(/tincan-server:1\.0\.1/g)).toHaveLength(2); // the app and the backup service
    expect(compose).toContain("tincan-web:1.0.1");
    expect(compose).toContain("livekit/livekit-server:v1.13.10");
    expect(compose).toContain("# host setting that must survive");
    expect(existsSync(join(h.dir, "docker-compose.yml.pre-deploy"))).toBe(true);
    expect(existsSync(join(h.dir, ".deploy.lock"))).toBe(false);
    expect(readFileSync(join(h.root, "deploy.log"), "utf8")).toContain("Deployed 1.0.1");
  });

  it("passes the passphrase file by path and never reads it", () => {
    const h = host();
    writeFileSync(join(h.root, "key"), "SECRET-PHRASE-xyz");
    const r = deploy(h, ["1.0.1"]);
    expect(r.code).toBe(0);
    expect(calls(h)).toContain(`${posix(h.root)}/key:/run/backup-passphrase:ro`);
    expect(r.out).not.toContain("SECRET-PHRASE-xyz");
    expect(readFileSync(join(h.root, "deploy.log"), "utf8")).not.toContain("SECRET-PHRASE-xyz");
  });

  it("migrates a host that builds from source: build blocks go, other lines stay", () => {
    const h = host({ build: true });
    const r = deploy(h, ["1.0.1"]);
    expect(r.code).toBe(0);
    const compose = h.compose();
    expect(compose).not.toContain("build:");
    expect(compose).not.toContain("context:");
    expect(compose).not.toContain("target:");
    expect(compose).toContain("image: ghcr.io/goransalzmann/tincan-server:1.0.1");
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).toContain('ports:\n      - "127.0.0.1:3000:3000"');
  });

  it("changes nothing when the backup fails", () => {
    const h = host();
    const r = deploy(h, ["1.0.1"], { FAKE_FAIL_BACKUP: "1" });
    expect(r.code).toBe(5);
    expect(h.compose()).toContain("tincan-server:1.0.0");
    expect(calls(h)).not.toContain("up -d");
    expect(existsSync(join(h.dir, ".deploy.lock"))).toBe(false);
  });

  it("changes nothing when the backup does not restore", () => {
    const h = host();
    const r = deploy(h, ["1.0.1"], { FAKE_FAIL_RESTORE: "1" });
    expect(r.code).toBe(5);
    expect(r.out).toContain("does not restore");
    expect(calls(h)).not.toContain("docker pull");
    expect(h.compose()).toContain("tincan-server:1.0.0");
  });

  it("changes nothing when an image cannot be pulled", () => {
    const h = host();
    const r = deploy(h, ["9.9.9"], { FAKE_FAIL_PULL: "1" });
    expect(r.code).toBe(6);
    expect(h.compose()).toContain("tincan-server:1.0.0");
    expect(calls(h)).not.toContain("up -d");
  });

  it("refuses to run twice at once, and ignores a stale lock", async () => {
    const h = host();
    mkdirSync(join(h.dir, ".deploy.lock"));
    // a process that is alive as far as sh can tell (its pid is the shell's own, not the OS's)
    const sleeper = spawn("sh", ["-c", "echo $$; exec sleep 60"], { stdio: ["ignore", "pipe", "ignore"] });
    const pid = await new Promise<string>((res) => sleeper.stdout.once("data", (d) => res(String(d).trim())));
    try {
      writeFileSync(join(h.dir, ".deploy.lock", "pid"), pid);
      expect(deploy(h, ["1.0.1"]).code).toBe(3);
    } finally {
      sleeper.kill();
    }
    writeFileSync(join(h.dir, ".deploy.lock", "pid"), "999999"); // not running
    expect(deploy(h, ["1.0.1"]).code).toBe(0);
  });

  it("rolls back to the old images when the new version is unhealthy and no migration ran", () => {
    const h = host();
    const r = deploy(h, ["1.0.1"], { FAKE_BAD: "1.0.1" });
    expect(r.code).toBe(10);
    expect(r.out).toContain("no data lost");
    expect(h.compose()).toContain("tincan-server:1.0.0");
    expect(readFileSync(join(h.dir, "data", "app.db"), "utf8")).toBe("original");
    expect(running(h)).toBe("1.0.0");
  });

  it("rolls back when doctor reports a check that passed before the deploy", () => {
    const h = host();
    const r = deploy(h, ["1.0.1"], { FAKE_DOCTOR_FAIL: "1.0.1" });
    expect(r.code).toBe(10);
    expect(r.out).toContain("[Disk space]");
    expect(h.compose()).toContain("tincan-server:1.0.0");
  });

  it("does not hold a check against the new version that already failed before the deploy", () => {
    const h = host();
    const r = deploy(h, ["1.0.1"], { FAKE_DOCTOR_FAIL: "1.0.0 1.0.1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("already failed before this deploy");
    expect(h.compose()).toContain("tincan-server:1.0.1");
  });

  it("restores the pre-migration snapshot when the old version cannot read the migrated database", () => {
    const h = host();
    const r = deploy(h, ["1.1.0"], { FAKE_MIGRATES: "1.1.0", FAKE_BAD: "1.1.0" });
    expect(r.code).toBe(11);
    expect(r.out).toContain("is gone");
    expect(r.out).toContain("pre-migration snapshot");
    expect(h.compose()).toContain("tincan-server:1.0.0");
    expect(readFileSync(join(h.dir, "data", "app.db"), "utf8")).toContain("snapshot before migration");
    expect(readdirSync(join(h.dir, "data")).some((f) => f.startsWith("app.db.failed-"))).toBe(true);
    expect(running(h)).toBe("1.0.0");
  });

  it("falls back to the backup when no snapshot exists", () => {
    const h = host();
    const r = deploy(h, ["1.1.0"], { FAKE_MIGRATES: "1.1.0", FAKE_BAD: "1.1.0", FAKE_NO_SNAPSHOT: "1" });
    expect(r.code).toBe(11);
    expect(r.out).toContain("restoring the backup");
    expect(readFileSync(join(h.dir, "data", "app.db"), "utf8")).toContain("backup copy");
  });

  it("goes back to a locally built image when the first release deploy fails", () => {
    const h = host({ build: true });
    const r = deploy(h, ["1.0.1"], { FAKE_BAD: "1.0.1", FAKE_OLD: "local" });
    expect(r.code).toBe(10);
    expect(h.compose()).toContain("build:");
    expect(h.compose()).toContain("image: tincan-server");
  });

  it("says so when even the rollback fails", () => {
    const h = host();
    const r = deploy(h, ["1.1.0"], { FAKE_MIGRATES: "1.1.0", FAKE_BAD: "1.1.0 1.0.0" });
    expect(r.code).toBe(12);
    expect(r.out).toContain("needs a person");
  });
});
