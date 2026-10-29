// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The 3-person media test (16 §6, 17 M3): the real server, the real web client and a real LiveKit, with three headless
 * Chromium clients on fake audio devices.
 *
 *   pnpm build && pnpm media-test
 *
 * On Linux it starts LiveKit with host networking itself. Where that is not available (Docker Desktop), use
 * `sh tools/media-test/docker.sh`, which runs everything in two containers sharing one network namespace.
 * Chromium: the one Playwright installed, or CHROMIUM_CHANNEL=chrome|msedge, or CHROMIUM_PATH.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { preview } from "vite";
import { PERM, permissionsToString } from "../../packages/shared/src/index.js";
import { boot, type RunningApp } from "../../apps/server/src/boot.js";
import { parseCoreConfig } from "../../apps/server/src/config/load.js";

const IMAGE = readFileSync(resolve("apps/server/src/cli/templates.ts"), "utf8").match(
  /LIVEKIT_IMAGE = "([^"]+)"/,
)![1]!;
// Must match tools/media-test/livekit.yaml.
const KEY = "mediakey";
const SECRET = "media-test-secret-0123456789abcdef";
const PASSWORD = "correct horse battery staple";
const APP = "http://127.0.0.1:3000";
const WEB = "http://127.0.0.1:5173";
const linux = process.platform === "linux";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; note?: string }[] = [];
const pagesToShoot: Page[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, note: `${Date.now() - t0} ms` });
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, note: (err as Error).message.split("\n")[0] ?? "" });
    console.log(`  FAIL ${name}: ${(err as Error).message.split("\n")[0]}`);
    for (const p of pagesToShoot) {
      const text = await p
        .locator("body")
        .innerText()
        .catch(() => "?");
      console.log(`    page text: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
    }
    if (process.env.MEDIA_SHOTS) {
      await Promise.all(
        pagesToShoot.map((p, i) =>
          p
            .screenshot({ path: join(process.env.MEDIA_SHOTS!, `fail-${results.length}-${i}.png`) })
            .catch(() => undefined),
        ),
      );
    }
  }
}

async function until(what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// ---- LiveKit -----------------------------------------------------------------------------------

function startLiveKit(): void {
  if (process.env.MEDIA_LK === "external") return; // tools/media-test/docker.sh started it
  if (!linux)
    throw new Error("Needs Linux host networking. On Docker Desktop run: sh tools/media-test/docker.sh");
  try {
    execFileSync("docker", ["rm", "-f", "tincan-media-lk"], { stdio: "ignore" });
  } catch {
    // none running
  }
  const cfg = resolve("tools/media-test/livekit.yaml");
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      "tincan-media-lk",
      "--network",
      "host",
      "-v",
      `${cfg}:/etc/livekit.yaml:ro`,
      IMAGE,
      "--config",
      "/etc/livekit.yaml",
    ],
    { stdio: "ignore" },
  );
}

async function waitForLiveKit(): Promise<void> {
  await until("LiveKit", async () => (await fetch("http://127.0.0.1:7880")).ok, 30_000);
}

// ---- app and web ---------------------------------------------------------------------------------

function appConfig(dir: string) {
  return parseCoreConfig({
    security: { instanceSecret: "media-test-".padEnd(40, "x") },
    instance: { name: "Media Test", publicUrl: WEB },
    dataDir: dir,
    adapters: {
      database: { kind: "sqlite", path: join(dir, "app.db") },
      storage: { kind: "local", path: join(dir, "files") },
    },
    server: { host: "127.0.0.1", port: 3000, allowedOrigins: [WEB] },
    log: { level: "warn" },
    livekit: { url: "ws://127.0.0.1:7880", apiUrl: "http://127.0.0.1:7880", apiKey: KEY, apiSecret: SECRET },
    modules: {
      accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
      voice: { reconcileIntervalMs: 3000 },
    },
  });
}

async function api<T = unknown>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(`${APP}/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

// ---- browsers --------------------------------------------------------------------------------------

interface Client {
  name: string;
  ctx: BrowserContext;
  page: Page;
}

const trackPeerConnections = `(() => {
  window.__pcs = [];
  const Orig = window.RTCPeerConnection;
  function Wrapped(...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; }
  Wrapped.prototype = Orig.prototype;
  Object.setPrototypeOf(Wrapped, Orig);
  window.RTCPeerConnection = Wrapped;
})()`;

async function launch(): Promise<Browser> {
  return chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    ...(process.env.CHROMIUM_CHANNEL ? { channel: process.env.CHROMIUM_CHANNEL } : {}),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
    ],
  });
}

async function client(browser: Browser, name: string): Promise<Client> {
  const ctx = await browser.newContext({ permissions: ["microphone"], baseURL: WEB });
  await ctx.addInitScript({ content: trackPeerConnections });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log(`  [${name}] console ${m.type()}: ${m.text().slice(0, 200)}`);
  });
  await page.goto("/login");
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("link", { name: /Join voice channel Lounge/ }).waitFor({ timeout: 15_000 });
  pagesToShoot.push(page);
  return { name, ctx, page };
}

/** Total inbound audio over all peer connections of a page: bytes, packets and decoded energy. */
const INBOUND = `(async () => {
  const out = { bytes: 0, energy: 0, codecs: [], lost: 0, packets: 0 };
  for (const pc of window.__pcs) {
    const report = await pc.getStats();
    const codecs = new Map();
    report.forEach((s) => { if (s.type === "codec") codecs.set(s.id, s.mimeType); });
    report.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "audio") {
        out.bytes += s.bytesReceived || 0;
        out.energy += s.totalAudioEnergy || 0;
        out.lost += s.packetsLost || 0;
        out.packets += s.packetsReceived || 0;
        const c = codecs.get(s.codecId);
        if (c && !out.codecs.includes(c)) out.codecs.push(c);
      }
    });
  }
  return out;
})()`;

interface Inbound {
  bytes: number;
  energy: number;
  codecs: string[];
  lost: number;
  packets: number;
}

const inbound = (p: Page) => p.evaluate<Inbound>(INBOUND);

const sidebarCount = (p: Page, n: number) =>
  p.getByRole("list", { name: new RegExp(`^${n} (person|people) in Lounge`) }).waitFor({ timeout: 15_000 });
const dock = (p: Page) => p.getByRole("region", { name: "Voice" });

// ---- the test ------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "tincan-media-"));
  let app: RunningApp | null = null;
  let web: { close(): Promise<void> } | null = null;
  let browser: Browser | null = null;
  try {
    console.log(`Starting LiveKit (${IMAGE}) …`);
    startLiveKit();
    app = await boot({ config: appConfig(dir) });
    await waitForLiveKit();
    process.env.TINCAN_DEV_SERVER = APP;
    const server = await preview({
      root: resolve("apps/web"),
      preview: { host: "127.0.0.1", port: 5173, strictPort: true },
    });
    web = { close: () => server.close() };

    const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
    const owner = await api<{ token: string }>("POST", "/auth/setup", undefined, {
      token,
      username: "mika",
      displayName: "Mika",
      password: PASSWORD,
    });
    const ids: Record<string, string> = {};
    for (const n of ["ann", "bo", "cy"]) {
      const r = await api<{ user: { id: string } }>("POST", "/auth/register", undefined, {
        username: n,
        displayName: n,
        password: PASSWORD,
      });
      ids[n] = r.user.id;
    }
    const { channels } = await api<{ channels: { id: string; type: string }[] }>(
      "GET",
      "/channels",
      owner.token,
    );
    const lounge = channels.find((c) => c.type === "voice")!.id;

    browser = await launch();
    console.log("Logging three people in …");
    const [ann, bo, cy] = [
      await client(browser, "ann"),
      await client(browser, "bo"),
      await client(browser, "cy"),
    ];
    const all = [ann, bo, cy];

    console.log("Running:");
    await step("all three join the voice channel and see each other", async () => {
      for (const c of all) await c.page.getByRole("link", { name: /Join voice channel Lounge/ }).click();
      for (const c of all) await dock(c.page).getByText("Voice connected").waitFor({ timeout: 20_000 });
      for (const c of all) await sidebarCount(c.page, 3);
    });

    if (process.env.MEDIA_ONLY === "join" && results.some((r) => !r.ok))
      throw new Error("stopped after the first failure");
    await step("inbound audio flows with Opus and little loss", async () => {
      const before = await Promise.all(all.map((c) => inbound(c.page)));
      await sleep(4000);
      const after = await Promise.all(all.map((c) => inbound(c.page)));
      after.forEach((a, i) => {
        const b = before[i]!;
        if (a.bytes - b.bytes < 2000)
          throw new Error(`${all[i]!.name} received ${a.bytes - b.bytes} audio bytes in 4 s`);
        if (!a.codecs.some((m) => /opus/i.test(m)))
          throw new Error(`${all[i]!.name}: codecs ${a.codecs.join(",")}`);
        const loss = (a.lost - b.lost) / Math.max(1, a.packets - b.packets);
        if (loss > 0.05) throw new Error(`${all[i]!.name}: loss ${(loss * 100).toFixed(1)}%`);
      });
    });

    await step("the server sees all three, with their microphone published", async () => {
      const v = await api<{ voice: Record<string, { userId: string; sources: string[] }[]> }>(
        "GET",
        "/voice/state",
        owner.token,
      );
      const here = v.voice[lounge] ?? [];
      if (here.length !== 3) throw new Error(`server presence has ${here.length} people`);
      for (const p of here)
        if (!p.sources.includes("microphone")) throw new Error(`${p.userId} has no microphone track`);
    });

    await step("mute reaches the others; unmute restores", async () => {
      await dock(ann.page).getByRole("button", { name: "Mute", exact: true }).click();
      await bo.page
        .getByRole("list", { name: /in Lounge/ })
        .getByLabel("muted")
        .waitFor({ timeout: 8000 });
      await dock(ann.page).getByRole("button", { name: "Unmute", exact: true }).click();
      await until(
        "unmuted",
        async () =>
          (await bo.page
            .getByRole("list", { name: /in Lounge/ })
            .getByLabel("muted")
            .count()) === 0,
        8000,
      );
    });

    await step("deafen stops incoming audio and tells the others", async () => {
      await dock(bo.page).getByRole("button", { name: "Deafen", exact: true }).click();
      await cy.page
        .getByRole("list", { name: /in Lounge/ })
        .getByLabel("deafened")
        .waitFor({ timeout: 8000 });
      const a = await inbound(bo.page);
      await sleep(3000);
      const b = await inbound(bo.page);
      if (b.bytes - a.bytes > 4000)
        throw new Error(`still received ${b.bytes - a.bytes} bytes while deafened`);
      await dock(bo.page).getByRole("button", { name: "Undeafen", exact: true }).click();
      await dock(bo.page).getByRole("button", { name: "Unmute", exact: true }).click();
      const c = await inbound(bo.page);
      await sleep(3000);
      const d = await inbound(bo.page);
      if (d.bytes - c.bytes < 2000) throw new Error("audio did not come back after undeafen");
    });

    await step("the app server restarts and the call goes on", async () => {
      await app!.close();
      await sleep(1500);
      app = await boot({ config: appConfig(dir) });
      const a = await inbound(cy.page);
      await sleep(3000);
      const b = await inbound(cy.page);
      if (b.bytes - a.bytes < 2000) throw new Error("audio stopped while the app restarted");
      for (const c of all) await sidebarCount(c.page, 3); // presence rebuilt from LiveKit and re-sent
    });

    await step("a network drop reconnects and the person stays in the call", async () => {
      await cy.ctx.setOffline(true);
      await sleep(3000);
      await cy.ctx.setOffline(false);
      await dock(cy.page).getByText("Voice connected").waitFor({ timeout: 40_000 });
      const a = await inbound(cy.page);
      await sleep(3000);
      const b = await inbound(cy.page);
      if (b.bytes - a.bytes < 2000) throw new Error("no audio after reconnecting");
    });

    await step("taking CONNECT away removes the person from the call within seconds", async () => {
      const t0 = Date.now();
      await api("PUT", `/channels/${lounge}/overwrites/member/${ids.ann}`, owner.token, {
        allow: "0",
        deny: permissionsToString(PERM.CONNECT),
      });
      await ann.page.getByText("You no longer have permission").waitFor({ timeout: 8000 });
      await sidebarCount(bo.page, 2);
      if (Date.now() - t0 > 6000) throw new Error(`took ${Date.now() - t0} ms`);
    });

    await step("leaving clears the sidebar for the others", async () => {
      await dock(cy.page).getByRole("button", { name: "Leave voice channel" }).click();
      await sidebarCount(bo.page, 1);
      await dock(bo.page).getByRole("button", { name: "Leave voice channel" }).click();
      await until(
        "empty room",
        async () =>
          Object.keys((await api<{ voice: object }>("GET", "/voice/state", owner.token)).voice).length === 0,
        10_000,
      );
    });

    await step("the reconciler counted nothing it should not have needed to repair", async () => {
      const s = await api<{ reconcile: { repairs: Record<string, number>; failures: number } }>(
        "GET",
        "/voice/status",
        owner.token,
      );
      // Webhooks and the fast path did the work. A few repairs after the app restart are expected (presence rebuilt), the rest should be zero.
      const unexpected = ["permission_updated", "participant_removed", "duplicate_session"].filter(
        (k) => (s.reconcile.repairs[k] ?? 0) > 0,
      );
      if (unexpected.length) throw new Error(`repairs: ${JSON.stringify(s.reconcile.repairs)}`);
      if (s.reconcile.failures > 0) throw new Error(`${s.reconcile.failures} failed passes`);
    });
  } catch (err) {
    console.error(err);
    results.push({ name: "setup", ok: false, note: (err as Error).message });
  } finally {
    await browser?.close().catch(() => undefined);
    await web?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    if (process.env.MEDIA_LK !== "external")
      spawn("docker", ["rm", "-f", "tincan-media-lk"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length ? 1 : 0;
}

process.exit(await main());
