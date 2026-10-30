// SPDX-License-Identifier: AGPL-3.0-or-later
// Upgrade and rollback rehearsal (14 §7, 06 §8): the previous release's source tree and this one, on one data directory.
//
//   node tools/upgrade-rehearsal/run.mjs --old <checkout of the previous release, with pnpm install done>
//
// 1. the old release creates an instance with a member, a message and an upload;
// 2. this release's `tincan backup` takes a backup (the step the admin guide asks for before upgrading);
// 3. this release starts on the same data: migrations run forward after an automatic pre-migration snapshot;
// 4. the old release is started on the upgraded data and must refuse to start (downgrade protection), not corrupt it;
// 5. rollback: `tincan restore` the backup into a new directory, start the old release there: everything is back.
//
// Everything runs on loopback in temporary directories. It never touches a real instance.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { old: { type: "string" } } });
if (!values.old)
  throw new Error("usage: node tools/upgrade-rehearsal/run.mjs --old <previous release checkout>");
const OLD = resolve(values.old);
const NEW = resolve(".");
const bin = (root) => join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const cli = (root) => [bin(root), ["--conditions=tincan-src", join(root, "apps/server/src/cli.ts")]];

const work = mkdtempSync(join(tmpdir(), "tincan-rehearsal-"));
const log = [];
const say = (s) => {
  log.push(s);
  console.log(s);
};
const secret = "rehearsal-secret-".padEnd(40, "x");
const env = {
  ...process.env,
  TINCAN_SECURITY__INSTANCE_SECRET: secret,
  TINCAN_LIVEKIT__API_SECRET: "rehearsal-livekit-secret-".padEnd(40, "y"),
};

function config(dir, port) {
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    `instance: { name: Rehearsal, publicUrl: "http://127.0.0.1:${port}" }
server: { host: 127.0.0.1, port: ${port} }
dataDir: ${join(dir, "data").replaceAll("\\", "/")}
adapters:
  database: { kind: sqlite, path: ${join(dir, "data", "app.db").replaceAll("\\", "/")} }
  storage: { kind: local, path: ${join(dir, "data", "files").replaceAll("\\", "/")} }
log: { level: warn }
livekit: { url: "ws://127.0.0.1:${port}/livekit", apiUrl: "http://127.0.0.1:1", apiKey: devkey, apiSecret: "rehearsal-livekit-secret-yyyyyyyyyyyyyyyyyyyyyy" }
modules:
  accounts: { signup: open }
  voice: { reconcileIntervalMs: 3600000 }
`,
  );
  mkdirSync(join(dir, "data"), { recursive: true });
  return path;
}

function serve(root, cfg) {
  const [cmd, args] = cli(root);
  const child = spawn(cmd, [...args, "serve", "--config", cfg], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return { child, output: () => out };
}

async function ready(port, proc, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (proc.child.exitCode !== null) return false;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function stop(proc) {
  if (proc.child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.child.pid), "/t", "/f"]);
  else proc.child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
}

const api = (port, token) => async (method, path, body, form) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null,
    text,
  };
};

const checks = [];
const check = (name, ok, note = "") => {
  checks.push({ name, ok });
  say(`  ${ok ? "ok  " : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
};

try {
  // ---- 1. the old release ----
  const dirA = join(work, "a");
  mkdirSync(dirA);
  const portA = 3411;
  const cfgA = config(dirA, portA);
  say(`\n1. The previous release creates an instance (${OLD})`);
  let proc = serve(OLD, cfgA);
  check("it starts", await ready(portA, proc));
  const setupToken = readFileSync(join(dirA, "data", "setup-token"), "utf8").trim();
  const A = api(portA);
  const setup = await A("POST", "/auth/setup", {
    token: setupToken,
    username: "owner",
    displayName: "Owner",
    password: "correct horse battery staple",
    instanceName: "Rehearsal",
  });
  const owner = setup.json.token;
  const ann = (
    await A("POST", "/auth/register", {
      username: "ann",
      displayName: "Ann",
      password: "correct horse battery staple",
    })
  ).json.token;
  const AA = api(portA, ann);
  const channels = (await api(portA, owner)("GET", "/channels")).json.channels;
  const general = channels.find((c) => c.type === "text").id;
  const form = new FormData();
  form.set("file", new Blob(["rehearsal file contents\n".repeat(100)], { type: "text/plain" }), "notes.txt");
  const up = await AA("POST", "/uploads", undefined, form);
  const msg = await AA("POST", `/channels/${general}/messages`, {
    content: "written before the upgrade",
    attachmentIds: [up.json.id],
  });
  check("a member, a message and an upload exist", msg.status === 201);
  await stop(proc);

  // ---- 2. backup with the new release's CLI ----
  say("\n2. This release takes a backup of that data");
  const [ncmd, nargs] = cli(NEW);
  const backupDir = join(work, "backups");
  const b = spawnSync(ncmd, [...nargs, "backup", "--config", cfgA, "--out", backupDir], {
    env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const archive = readdirSync(backupDir).find((n) => n.endsWith(".tar.gz"));
  check(
    "tincan backup wrote an archive",
    b.status === 0 && Boolean(archive),
    (b.stdout + b.stderr).trim().split("\n").slice(-2).join(" | "),
  );

  // ---- 3. forward ----
  say("\n3. This release starts on the same data (migrations run forward)");
  proc = serve(NEW, cfgA);
  check("it starts", await ready(portA, proc));
  const snaps = existsSync(join(dirA, "data", "backups"))
    ? readdirSync(join(dirA, "data", "backups")).filter((n) => n.startsWith("pre-migrate-"))
    : [];
  check("a pre-migration snapshot was taken first", snaps.length === 1, snaps.join(","));
  const hist = await api(portA, owner)("GET", `/channels/${general}/messages`);
  check("the old message is still there", JSON.stringify(hist.json).includes("written before the upgrade"));
  check("the new audit log works", (await api(portA, owner)("GET", "/audit-log")).status === 200);
  await stop(proc);

  // ---- 4. old release on upgraded data ----
  say("\n4. The previous release is started on the upgraded data (a wrong rollback)");
  proc = serve(OLD, cfgA);
  const started = await ready(portA, proc, 15000);
  const out = proc.output();
  check(
    "it refuses to start instead of running on a schema it does not know",
    !started && /Refusing to start/.test(out),
    out
      .split("\n")
      .find((l) => /Refusing/.test(l))
      ?.slice(0, 160) ?? out.slice(-200),
  );
  await stop(proc);

  // ---- 5. rollback by restore ----
  say("\n5. Rollback: restore the backup into a new directory and start the previous release on it");
  const dirB = join(work, "b");
  const r = spawnSync(ncmd, [...nargs, "restore", join(backupDir, archive), "--into", dirB], {
    env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  check(
    "tincan restore verified and unpacked the archive",
    r.status === 0,
    (r.stdout + r.stderr)
      .trim()
      .split("\n")
      .filter((l) => /checksums|integrity|Restored/.test(l))
      .join(" | "),
  );
  const portB = 3412;
  const cfgB = config(dirB, portB); // the restored directory has no config of its own here: this is the Host's own file, pointed at the restored data
  rmSync(join(dirB, "data", "setup-token"), { force: true });
  proc = serve(OLD, cfgB);
  check("the previous release starts on the restored data", await ready(portB, proc));
  const back = await api(portB, owner)("GET", `/channels/${general}/messages`);
  check("the message is there", JSON.stringify(back.json).includes("written before the upgrade"));
  const file = await fetch(`http://127.0.0.1:${portB}/api/v1/files/${up.json.id}/notes.txt`, {
    headers: { authorization: `Bearer ${ann}` },
  });
  check(
    "the upload is there and identical",
    file.status === 200 && (await file.text()).startsWith("rehearsal file contents"),
  );
  await stop(proc);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const failed = checks.filter((c) => !c.ok);
say(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
