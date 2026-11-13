#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Starts the BUILT server (apps/server/dist) with plain Node and waits for /readyz.
// Vitest and tsc accept things Node does not (a default import of an ESM-only package, a missing file
// extension), so only running the compiled output catches a server that cannot start.
// Run after `pnpm build`.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../apps/server/dist/cli.js", import.meta.url));
const TIMEOUT_MS = 60_000;

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const dir = mkdtempSync(join(tmpdir(), "tincan-boot-"));
const config = join(dir, "config.yaml");
writeFileSync(
  config,
  [
    "instance: { publicUrl: http://localhost:" + port + " }",
    "server: { host: 127.0.0.1, port: " + port + " }",
    `dataDir: ${dir}/data`,
    "security: { instanceSecret: boot-check-secret-boot-check-secret-0123456789 }",
    "adapters:",
    `  database: { kind: sqlite, path: ${dir}/app.db }`,
    `  storage: { kind: local, path: ${dir}/files }`,
    "log: { level: warn }",
    "",
  ].join("\n"),
);

const child = spawn(process.execPath, [cli, "serve", "--config", config], {
  env: { ...process.env, NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
let exited = null;
child.on("exit", (code, signal) => (exited = { code, signal }));

async function ready() {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    if (exited) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const ok = await ready();
child.kill("SIGTERM");
await new Promise((r) => (exited ? r() : child.once("exit", r)));
rmSync(dir, { recursive: true, force: true });

if (!ok) {
  console.error(output.trim() || "(no output)");
  console.error(
    exited ? `Server exited early (${JSON.stringify(exited)}).` : "Server was not ready in time.",
  );
  process.exit(1);
}
console.log("Built server booted and answered /readyz.");
