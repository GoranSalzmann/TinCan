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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ---- a speech-like microphone ----------------------------------------------------------------------

/**
 * A 16 s loop of 48 kHz mono 16-bit audio: 12 s of "syllables" (0.25 s of harmonics around 140 Hz at about −42 dBFS rms, 80 ms
 * gaps), then 4 s of near silence. Quiet and gappy like talking, unlike the full-scale beep of Chromium's default fake device.
 */
export function speechWav(): Buffer {
  const rate = 48_000;
  const n = rate * 16;
  const pcm = Buffer.alloc(n * 2);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    if (t < 12) {
      const phase = t % 0.33;
      if (phase < 0.25) {
        const env = Math.sin((Math.PI * phase) / 0.25);
        for (let h = 1; h <= 8; h++) v += (Math.sin(2 * Math.PI * 140 * h * t) / h) * env;
        v *= 0.012;
      }
    }
    seed = (seed * 1664525 + 1013904223) >>> 0;
    v += ((seed / 2 ** 32) * 2 - 1) * 0.0005;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
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

async function launch(extraArgs: string[] = []): Promise<Browser> {
  return chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    ...(process.env.CHROMIUM_CHANNEL ? { channel: process.env.CHROMIUM_CHANNEL } : {}),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      ...extraArgs,
    ],
  });
}

async function client(browser: Browser, name: string, initScripts: string[] = []): Promise<Client> {
  const ctx = await browser.newContext({ permissions: ["microphone"], baseURL: WEB });
  await ctx.addInitScript({ content: trackPeerConnections });
  await ctx.addInitScript({ content: `localStorage.setItem('tincan.debug', '1')` });
  for (const content of initScripts) await ctx.addInitScript({ content });
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
/** Energy per output channel of everything a page plays from the call, over `ms`: both ears must carry the voices. */
const CHANNELS = (ms: number) => `(async () => {
  const ctx = new AudioContext();
  const taps = [];
  for (const el of document.querySelectorAll("audio[data-tincan-voice]")) {
    if (!el.srcObject) continue;
    const src = ctx.createMediaStreamSource(el.srcObject);
    const split = ctx.createChannelSplitter(2);
    src.connect(split);
    taps.push([0, 1].map((i) => { const an = ctx.createAnalyser(); an.fftSize = 2048; split.connect(an, i); return an; }));
  }
  const energy = [0, 0];
  const buf = new Float32Array(2048);
  const end = Date.now() + ${ms};
  while (Date.now() < end) {
    for (const pair of taps) pair.forEach((an, i) => { an.getFloatTimeDomainData(buf); for (const v of buf) energy[i] += v * v; });
    await new Promise((r) => setTimeout(r, 40));
  }
  await ctx.close();
  return { left: energy[0], right: energy[1], sources: taps.length };
})()`;

/** Energy per channel of one person's voice after the per-person gain and limiter, over `ms`. */
const LEVELS = (userId: string, ms: number) => `(async () => {
  const m = window.__tincanVoice;
  const e = [0, 0];
  const end = Date.now() + ${ms};
  while (Date.now() < end) {
    const l = m.levels("${userId}");
    if (l) { e[0] += l.left; e[1] += l.right; }
    await new Promise((r) => setTimeout(r, 30));
  }
  return { left: e[0], right: e[1] };
})()`;

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

    await step(
      "taking SPEAK away silences the microphone, and giving it back restores it without rejoining",
      async () => {
        const micOf = async (userId: string) => {
          const v = await api<{ voice: Record<string, { userId: string; sources: string[] }[]> }>(
            "GET",
            "/voice/state",
            owner.token,
          );
          return (
            (v.voice[lounge] ?? []).find((p) => p.userId === userId)?.sources.includes("microphone") ?? false
          );
        };
        await api("PUT", `/channels/${lounge}/overwrites/member/${ids.cy}`, owner.token, {
          allow: "0",
          deny: permissionsToString(PERM.SPEAK),
        });
        await until("microphone revoked", async () => !(await micOf(ids.cy!)), 8000);
        await api("DELETE", `/channels/${lounge}/overwrites/member/${ids.cy}`, owner.token);
        await until("microphone published again", () => micOf(ids.cy!), 10_000);
        // The republished track needs a moment before its packets reach bo: poll instead of one fixed window.
        const a = await inbound(bo.page);
        await until(
          "audio after the right to speak came back",
          async () => (await inbound(bo.page)).bytes - a.bytes >= 2000,
          12_000,
        );
      },
    );

    await step("what is heard is centred: left and right carry the same voice", async () => {
      // Regression: RNNoise wrote only output channel 0, so a stereo-declared microphone came out left-only.
      for (const c of all) {
        const e = await c.page.evaluate<{ left: number; right: number; sources: number }>(CHANNELS(3000));
        if (e.sources < 2) throw new Error(`${c.name} plays ${e.sources} remote sources`);
        if (e.left + e.right === 0) throw new Error(`${c.name} heard nothing`);
        const ratio = Math.min(e.left, e.right) / Math.max(e.left, e.right);
        if (ratio < 0.5)
          throw new Error(`${c.name}: left ${e.left.toFixed(3)} vs right ${e.right.toFixed(3)}`);
      }
    });

    await step("a person can be turned up past 100 %, still on both channels and limited", async () => {
      const measure = async (volume: number) => {
        await bo.page.evaluate(`window.__tincanVoice.setUserVolume("${ids.cy}", ${volume})`);
        await sleep(300);
        return bo.page.evaluate<{ left: number; right: number }>(LEVELS(ids.cy!, 4000));
      };
      // The fake microphone is a full-scale beep, so 300 % hits the limiter hard: it must not be quieter than 100 %, and it
      // must not lose a channel. That the gain itself works is shown below 100 %, where nothing is limited.
      const quiet = await measure(0.25);
      const base = await measure(1);
      const loud = await measure(3);
      const sum = (e: { left: number; right: number }) => e.left + e.right;
      if (sum(base) === 0) throw new Error("no signal at 100 %");
      if (sum(base) < 4 * sum(quiet))
        throw new Error(`25 % is not quieter: ${sum(quiet).toFixed(2)} vs ${sum(base).toFixed(2)}`);
      if (sum(loud) < 0.9 * sum(base))
        throw new Error(`300 % is quieter than 100 %: ${sum(loud).toFixed(2)} vs ${sum(base).toFixed(2)}`);
      if (Math.min(loud.left, loud.right) / Math.max(loud.left, loud.right) < 0.5) {
        throw new Error(`lost a channel at 300 %: ${loud.left.toFixed(2)} / ${loud.right.toFixed(2)}`);
      }
      await bo.page.evaluate(`window.__tincanVoice.setUserVolume("${ids.cy}", 1)`);
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

    await step("the local speaking ring follows the outgoing voice, not single moments", async () => {
      // A fourth person on a speech-like fake microphone: 12 s of syllables, 4 s of silence, repeating.
      const wav = join(dir, "speech.wav");
      writeFileSync(wav, speechWav());
      const speechBrowser = await launch([`--use-file-for-fake-audio-capture=${wav}`]);
      try {
        await api("POST", "/auth/register", undefined, {
          username: "dee",
          displayName: "dee",
          password: PASSWORD,
        });
        // A quiet microphone with no automatic gain and no denoiser: what comes out of the pipeline is what the mic delivers.
        const quietMic = `localStorage.setItem('tincan.audio.v1', JSON.stringify({ preset: 'natural', noiseTier: 'browser', autoGain: false }))`;
        const dee = await client(speechBrowser, "dee", [quietMic]);
        await dee.page.getByRole("link", { name: /Join voice channel Lounge/ }).click();
        await dock(dee.page).getByText("Voice connected").waitFor({ timeout: 20_000 });
        await sleep(2000);
        const samples = await dee.page.evaluate<number[]>(`(async () => {
          const out = [];
          const end = Date.now() + 16000;
          while (Date.now() < end) {
            out.push(document.querySelector('li[aria-label="dee is speaking"]') ? 1 : 0);
            await new Promise((r) => setTimeout(r, 40));
          }
          return out;
        })()`);
        const on = samples.reduce((a, b) => a + b, 0) / samples.length;
        const flips = samples.filter((v, i) => i > 0 && v !== samples[i - 1]).length;
        // Ideal: on for 12 of 16 s (75 %) with two changes. Tolerate a hold time at the end and a late start.
        if (on < 0.55 || on > 0.92)
          throw new Error(`ring was on ${(on * 100).toFixed(0)} % of the time (expected about 75 %)`);
        if (flips > 8) throw new Error(`ring changed ${flips} times in 16 s (expected about 2)`);
      } finally {
        await speechBrowser.close();
      }
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
