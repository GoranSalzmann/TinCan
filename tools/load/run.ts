// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Load and soak tests (16 §8, 17 M5). The real server runs in this process with a fake LiveKit (voice limits are
 * LiveKit's and are measured with the media test and spike D1); what is measured is this application's own cost:
 * concurrent WebSockets, message fan-out, the app side of a voice join storm, and uploads held in memory.
 *
 *   pnpm load                       every scenario at the default size, about two minutes
 *   pnpm load --scenario ws --sockets 2000
 *   pnpm load --scenario soak --minutes 30        (sh tools/load/soak.sh runs it in a memory-limited container)
 *
 * It never contacts anything but its own temporary server, so it is safe on any machine. Point it at a real instance
 * only by hand, with the owner's permission (it would create accounts and messages).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { hashToken } from "../../packages/auth/src/tokens.js";
import { newId, Op, voiceRoomName } from "../../packages/shared/src/index.js";
import { boot, type RunningApp } from "../../apps/server/src/boot.js";
import { parseCoreConfig } from "../../apps/server/src/config/load.js";
import { ALL_MODULES } from "../../apps/server/src/modules/index.js";
import { FakeLiveKit, jsonVerifier } from "../../apps/server/src/modules/voice/fake-livekit.js";
import { createVoiceModule } from "../../apps/server/src/modules/voice/index.js";

const { values: arg } = parseArgs({
  options: {
    scenario: { type: "string", default: "all" },
    sockets: { type: "string", default: "500" },
    senders: { type: "string", default: "20" },
    seconds: { type: "string", default: "20" },
    minutes: { type: "string", default: "5" },
    json: { type: "string" },
  },
});
const SOCKETS = Number(arg.sockets);
const SENDERS = Number(arg.senders);
const SECONDS = Number(arg.seconds);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const ms = (n: number) => (Number.isNaN(n) ? "n/a" : `${n.toFixed(1)} ms`);
const mib = (n: number) => `${(n / 1048576).toFixed(0)} MiB`;
const report: Record<string, unknown> = {};

interface Env {
  app: RunningApp;
  url: string;
  ws: string;
  fake: FakeLiveKit;
  dir: string;
  owner: string;
  general: string;
  lounge: string;
  users: { id: string; token: string }[];
}

/** Boots the app and creates `n` members straight in the database (login and registration are rate limited on purpose). */
async function start(n: number): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "tincan-load-"));
  const fake = new FakeLiveKit();
  const config = parseCoreConfig({
    security: {
      instanceSecret: "load-test-secret-".padEnd(40, "x"),
      rateLimit: {
        readsPerMinute: 10_000_000,
        writesPerMinute: 10_000_000,
        perIpPerMinute: 10_000_000,
        gatewaySocketsPerIp: 1_000_000,
        gatewaySessionsPerUser: 1000,
      },
    },
    instance: { name: "Load", publicUrl: "http://localhost" },
    dataDir: dir,
    adapters: {
      database: { kind: "sqlite", path: join(dir, "app.db") },
      storage: { kind: "local", path: join(dir, "files") },
    },
    server: { host: "127.0.0.1", port: 0 },
    log: { level: "silent" },
    livekit: {
      url: "ws://localhost/livekit",
      apiKey: "devkey",
      apiSecret: "load-livekit-secret-".padEnd(40, "x"),
    },
    modules: {
      accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
      "text-chat": { createRate: { max: 1_000_000, windowSecs: 1 } },
      voice: {
        reconcileIntervalMs: 3_600_000,
        e2ee: { enabled: false },
        joinRate: { max: 1_000_000, windowSecs: 1 },
      },
      uploads: { maxBytes: 512 * 1024 * 1024, userQuotaBytes: 100 * 1024 ** 3 },
    },
  });
  const app = await boot({
    config,
    modules: [
      ...ALL_MODULES.filter((m) => m.id !== "voice"),
      createVoiceModule({ rooms: fake, verify: jsonVerifier }),
    ],
  });
  const url = app.address!;
  const setupToken = (await import("node:fs")).readFileSync(join(dir, "setup-token"), "utf8").trim();
  const res = await fetch(`${url}/api/v1/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: setupToken,
      username: "owner",
      displayName: "Owner",
      password: "correct horse battery staple",
      instanceName: "Load",
    }),
  });
  const owner = ((await res.json()) as { token: string }).token;
  const channels = (await (
    await fetch(`${url}/api/v1/channels`, { headers: { authorization: `Bearer ${owner}` } })
  ).json()) as {
    channels: { id: string; type: string }[];
  };
  const db = app.ports.db.query as unknown as {
    selectFrom(t: string): { select(c: string): { executeTakeFirst(): Promise<{ id: string } | undefined> } };
    insertInto(t: string): { values(v: unknown): { execute(): Promise<unknown> } };
  };
  const space = (await db.selectFrom("space").select("id").executeTakeFirst())!.id;
  const now = Date.now();
  const users: Env["users"] = [];
  for (let i = 0; i < n; i++) {
    const id = newId(now + i);
    const token = randomBytes(24).toString("base64url");
    await db
      .insertInto("user")
      .values({
        id,
        username: `load${i}`,
        display_username: `load${i}`,
        display_name: `Load ${i}`,
        password_hash: null,
        created_at: now,
        is_instance_owner: 0,
      })
      .execute();
    await db.insertInto("member").values({ space_id: space, user_id: id, joined_at: now }).execute();
    await db
      .insertInto("session")
      .values({
        id: newId(now + i),
        user_id: id,
        token_hash: hashToken(token),
        created_at: now,
        last_used_at: now,
        expires_at: now + 86_400_000,
        client_name: "load",
        ip_hash: "x",
        user_agent: "load",
      })
      .execute();
    users.push({ id, token });
  }
  return {
    app,
    url,
    ws: url.replace(/^http/, "ws"),
    fake,
    dir,
    owner,
    general: channels.channels.find((c) => c.type === "text")!.id,
    lounge: channels.channels.find((c) => c.type === "voice")!.id,
    users,
  };
}

async function stop(env: Env): Promise<void> {
  await env.app.close();
  rmSync(env.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

interface Sock {
  ws: WebSocket;
  userId: string;
  ready: number;
  frames: { t?: string; d?: unknown; at: number }[];
}

async function openSocket(env: Env, u: { id: string; token: string }): Promise<Sock> {
  const t0 = performance.now();
  const ws = new WebSocket(`${env.ws}/gateway?v=1&encoding=json`);
  const sock: Sock = { ws, userId: u.id, ready: NaN, frames: [] };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("READY timeout")), 30_000);
    ws.on("message", (raw) => {
      const f = JSON.parse((raw as Buffer).toString()) as { op: number; t?: string; d?: unknown };
      if (f.op === Op.HELLO)
        ws.send(
          JSON.stringify({
            op: Op.IDENTIFY,
            d: { token: u.token, client: { name: "load", version: "1", platform: "node" } },
          }),
        );
      if (f.t === "READY") {
        sock.ready = performance.now() - t0;
        clearTimeout(timer);
        resolve();
      } else if (f.t) sock.frames.push({ t: f.t, d: f.d, at: performance.now() });
    });
    ws.on("error", reject);
  });
  return sock;
}

/** Opens sockets in waves of 50, so the listen backlog is not what is being measured. */
async function openMany(env: Env, users: Env["users"]): Promise<{ socks: Sock[]; failed: number }> {
  const socks: Sock[] = [];
  let failed = 0;
  for (let i = 0; i < users.length; i += 50) {
    const wave = await Promise.allSettled(users.slice(i, i + 50).map((u) => openSocket(env, u)));
    for (const w of wave) {
      if (w.status === "fulfilled") socks.push(w.value);
      else failed++;
    }
  }
  return { socks, failed };
}

/** Samples this process and the server's event-loop delay every 250 ms while `fn` runs. */
async function sampled<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; peakRss: number; peakBuffers: number; peakHeap: number }> {
  let peakRss = 0,
    peakBuffers = 0,
    peakHeap = 0;
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakBuffers = Math.max(peakBuffers, m.arrayBuffers);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  }, 50);
  try {
    return { result: await fn(), peakRss, peakBuffers, peakHeap };
  } finally {
    clearInterval(timer);
  }
}

async function metric(env: Env, name: string): Promise<number> {
  const text = await (await fetch(`${env.url}/api/v1/metrics`)).text();
  const m = new RegExp(`^${name} ([0-9.e+-]+)$`, "m").exec(text);
  return m ? Number(m[1]) : NaN;
}

// ---- scenarios ---------------------------------------------------------------------------------

async function scenarioSockets(): Promise<void> {
  console.log(`\n== WebSockets: ${SOCKETS} concurrent, held ${SECONDS} s ==`);
  const env = await start(SOCKETS);
  try {
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    const { socks, failed } = await openMany(env, env.users);
    const connectSecs = (performance.now() - t0) / 1000;
    const ready = socks.map((s) => s.ready);
    await sleep(SECONDS * 1000);
    const alive = socks.filter((s) => s.ws.readyState === WebSocket.OPEN).length;
    const lag99 = await metric(env, "nodejs_eventloop_lag_p99_seconds");
    const rss1 = process.memoryUsage().rss;
    const out = {
      requested: SOCKETS,
      connected: socks.length,
      failed,
      aliveAfterHold: alive,
      connectSeconds: +connectSecs.toFixed(1),
      readyP50: pct(ready, 50),
      readyP95: pct(ready, 95),
      readyP99: pct(ready, 99),
      rssGrowthPerSocketKiB: Math.round((rss1 - rss0) / Math.max(1, socks.length) / 1024),
      eventLoopLagP99Ms: lag99 * 1000,
    };
    report.sockets = out;
    console.log(
      `  connected ${out.connected}/${SOCKETS} in ${out.connectSeconds} s (failed ${failed}); alive after hold: ${alive}`,
    );
    console.log(`  READY latency p50 ${ms(out.readyP50)}  p95 ${ms(out.readyP95)}  p99 ${ms(out.readyP99)}`);
    console.log(
      `  memory growth about ${out.rssGrowthPerSocketKiB} KiB per socket (client side included); event-loop lag p99 ${ms(out.eventLoopLagP99Ms)}`,
    );
    socks.forEach((s) => s.ws.close());
  } finally {
    await stop(env);
  }
}

async function scenarioMessages(): Promise<void> {
  console.log(`\n== Messages: ${SENDERS} senders into one channel, ${SOCKETS} listeners, ${SECONDS} s ==`);
  const env = await start(SOCKETS + SENDERS);
  try {
    const { socks: listeners } = await openMany(env, env.users.slice(0, SOCKETS));
    const senders = env.users.slice(SOCKETS);
    const sentAt = new Map<string, number>();
    let sent = 0,
      errors = 0;
    const latency: number[] = [];
    const deadline = performance.now() + SECONDS * 1000;
    const post = async (token: string, i: number) => {
      const t = performance.now();
      const res = await fetch(`${env.url}/api/v1/channels/${env.general}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: `load message ${i}` }),
      });
      if (res.status !== 201) {
        errors++;
        return;
      }
      const m = (await res.json()) as { id: string };
      sentAt.set(m.id, t);
      sent++;
    };
    await Promise.all(
      senders.map(async (u, k) => {
        let i = 0;
        while (performance.now() < deadline) await post(u.token, k * 100000 + i++);
      }),
    );
    await sleep(1500);
    let received = 0;
    for (const l of listeners)
      for (const f of l.frames)
        if (f.t === "MESSAGE_CREATE") {
          received++;
          const t0 = sentAt.get((f.d as { message: { id: string } }).message.id);
          if (t0 !== undefined) latency.push(f.at - t0);
        }
    const lag99 = await metric(env, "nodejs_eventloop_lag_p99_seconds");
    const expected = sent * listeners.length;
    const out = {
      senders: SENDERS,
      listeners: listeners.length,
      sent,
      errors,
      sendsPerSecond: +(sent / SECONDS).toFixed(0),
      deliveries: received,
      expectedDeliveries: expected,
      deliveryRatio: +(received / Math.max(1, expected)).toFixed(4),
      deliveriesPerSecond: +(received / SECONDS).toFixed(0),
      latencyP50: pct(latency, 50),
      latencyP95: pct(latency, 95),
      latencyP99: pct(latency, 99),
      eventLoopLagP99Ms: lag99 * 1000,
    };
    report.messages = out;
    console.log(
      `  sent ${sent} (${out.sendsPerSecond}/s, errors ${errors}); delivered ${received} of ${expected} expected (${(out.deliveryRatio * 100).toFixed(2)} %), ${out.deliveriesPerSecond}/s`,
    );
    console.log(
      `  send → receive p50 ${ms(out.latencyP50)}  p95 ${ms(out.latencyP95)}  p99 ${ms(out.latencyP99)}; event-loop lag p99 ${ms(out.eventLoopLagP99Ms)}`,
    );
    listeners.forEach((l) => l.ws.close());
  } finally {
    await stop(env);
  }
}

async function scenarioVoice(): Promise<void> {
  const n = Math.min(SOCKETS, 200);
  console.log(`\n== Voice join storm (app side, fake LiveKit): ${n} joins at once into one room ==`);
  const env = await start(n);
  try {
    const { socks: watchers } = await openMany(env, env.users.slice(0, 50));
    const t0 = performance.now();
    const times: number[] = [];
    const results = await Promise.all(
      env.users.map(async (u) => {
        const t = performance.now();
        const res = await fetch(`${env.url}/api/v1/voice/channels/${env.lounge}/join`, {
          method: "POST",
          headers: { authorization: `Bearer ${u.token}`, "content-type": "application/json" },
          body: "{}",
        });
        times.push(performance.now() - t);
        // LiveKit would now tell the app the person arrived.
        if (res.status === 200)
          await fetch(`${env.url}/api/v1/internal/livekit/webhook`, {
            method: "POST",
            headers: { "content-type": "application/webhook+json", authorization: "ok" },
            body: JSON.stringify({
              id: `EV_${u.id}`,
              event: "participant_joined",
              createdAt: Math.floor(Date.now() / 1000),
              room: { name: voiceRoomName(env.lounge), sid: "RM" },
              participant: { identity: u.id, sid: `PA_${u.id}` },
              track: null,
            }),
          });
        return res.status;
      }),
    );
    await sleep(1000);
    const ok = results.filter((s) => s === 200).length;
    const full = results.filter((s) => s === 409).length;
    const updates = watchers.reduce(
      (a, w) => a + w.frames.filter((f) => f.t === "VOICE_STATE_UPDATE").length,
      0,
    );
    const out = {
      joins: n,
      ok,
      refusedFull: full,
      totalSeconds: +((performance.now() - t0) / 1000).toFixed(2),
      joinP50: pct(times, 50),
      joinP95: pct(times, 95),
      joinP99: pct(times, 99),
      stateUpdatesToWatchers: updates,
      eventLoopLagP99Ms: (await metric(env, "nodejs_eventloop_lag_p99_seconds")) * 1000,
    };
    report.voice = out;
    console.log(
      `  ${ok} joined, ${full} refused as full (limit 25 by default), all done in ${out.totalSeconds} s`,
    );
    console.log(
      `  join call p50 ${ms(out.joinP50)}  p95 ${ms(out.joinP95)}  p99 ${ms(out.joinP99)}; ${updates} VOICE_STATE_UPDATE frames reached 50 watchers; event-loop lag p99 ${ms(out.eventLoopLagP99Ms)}`,
    );
    watchers.forEach((w) => w.ws.close());
  } finally {
    await stop(env);
  }
}

/** A multipart body produced on the fly, so the client holds no copy: what is measured is the server's memory. */
function multipartStream(size: number, boundary: string): ReadableStream<Uint8Array> {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const chunk = Buffer.alloc(256 * 1024, 7);
  let sent = 0,
    phase = 0;
  return new ReadableStream({
    pull(c) {
      if (phase === 0) {
        c.enqueue(head);
        phase = 1;
        return;
      }
      if (sent < size) {
        const n = Math.min(chunk.length, size - sent);
        c.enqueue(chunk.subarray(0, n));
        sent += n;
        return;
      }
      if (phase === 1) {
        c.enqueue(tail);
        phase = 2;
        return;
      }
      c.close();
    },
  });
}

async function scenarioUploads(): Promise<void> {
  console.log("\n== Uploads held in memory (the 512 MiB per-file ceiling, 18 §L) ==");
  const cases: [number, number][] = [
    [25, 8],
    [100, 4],
    [256, 2],
    [512, 1],
    [512, 2],
  ];
  const rows: unknown[] = [];
  for (const [mb, concurrency] of cases) {
    const env = await start(concurrency);
    try {
      await sleep(300);
      global.gc?.();
      const base = process.memoryUsage();
      const size = mb * 1024 * 1024;
      const { result, peakRss, peakBuffers } = await sampled(() =>
        Promise.all(
          env.users.map(async (u) => {
            const boundary = `----load${randomBytes(6).toString("hex")}`;
            const res = await fetch(`${env.url}/api/v1/uploads`, {
              method: "POST",
              duplex: "half",
              headers: {
                authorization: `Bearer ${u.token}`,
                "content-type": `multipart/form-data; boundary=${boundary}`,
              },
              body: multipartStream(size, boundary),
            });
            return res.status;
          }),
        ),
      );
      const peakApp = await metric(env, "tincan_uploads_in_flight_peak_bytes");
      const row = {
        fileMiB: mb,
        concurrent: concurrency,
        statuses: result.join(","),
        rssBeforeMiB: Math.round(base.rss / 1048576),
        rssPeakMiB: Math.round(peakRss / 1048576),
        rssAddedMiB: Math.round((peakRss - base.rss) / 1048576),
        bufferPeakMiB: Math.round(peakBuffers / 1048576),
        addedPerUploadMiB: +((peakRss - base.rss) / 1048576 / concurrency).toFixed(0),
        serverCountedInFlightPeakMiB: Math.round(peakApp / 1048576),
      };
      rows.push(row);
      console.log(
        `  ${mb} MiB × ${concurrency}: status ${row.statuses}; process RSS ${mib(base.rss)} → ${mib(peakRss)} (+${row.rssAddedMiB} MiB, about ${row.addedPerUploadMiB} MiB per upload); buffers peak ${row.bufferPeakMiB} MiB`,
      );
    } finally {
      await stop(env);
    }
  }
  report.uploads = rows;
}

/** Steady mixed traffic for a long time; the memory and handle trend is the result. */
async function scenarioSoak(): Promise<void> {
  const minutes = Number(arg.minutes);
  console.log(`\n== Soak: ${minutes} min of mixed traffic, ${SOCKETS} sockets ==`);
  const env = await start(SOCKETS + 10);
  try {
    const { socks } = await openMany(env, env.users.slice(0, SOCKETS));
    const senders = env.users.slice(SOCKETS);
    const end = Date.now() + minutes * 60_000;
    const samples: {
      min: number;
      rssMiB: number;
      heapMiB: number;
      sockets: number;
      lagMs: number;
      sent: number;
    }[] = [];
    let sent = 0;
    const traffic = Promise.all(
      senders.map(async (u, k) => {
        let i = 0;
        while (Date.now() < end) {
          const r = await fetch(`${env.url}/api/v1/channels/${env.general}/messages`, {
            method: "POST",
            headers: { authorization: `Bearer ${u.token}`, "content-type": "application/json" },
            body: JSON.stringify({ content: `soak ${k}.${i++}` }),
          });
          if (r.status === 201) sent++;
          // Churn: a tenth of the sockets reconnect now and then.
          if (i % 50 === 0) {
            const s = socks[(k * 7 + i) % socks.length]!;
            s.ws.close();
            socks[(k * 7 + i) % socks.length] = await openSocket(
              env,
              env.users.find((x) => x.id === s.userId)!,
            );
          }
          await sleep(100);
        }
      }),
    );
    const start0 = Date.now();
    while (Date.now() < end) {
      await sleep(Math.min(60_000, Math.max(1000, end - Date.now())));
      const m = process.memoryUsage();
      samples.push({
        min: +((Date.now() - start0) / 60000).toFixed(1),
        rssMiB: Math.round(m.rss / 1048576),
        heapMiB: Math.round(m.heapUsed / 1048576),
        sockets: await metric(env, "tincan_gateway_sessions"),
        lagMs: (await metric(env, "nodejs_eventloop_lag_p99_seconds")) * 1000,
        sent,
      });
      const s = samples.at(-1)!;
      console.log(
        `  t=${s.min} min  rss ${s.rssMiB} MiB  heap ${s.heapMiB} MiB  gateway sessions ${s.sockets}  loop lag p99 ${s.lagMs.toFixed(1)} ms  messages ${s.sent}`,
      );
    }
    await traffic;
    const half = samples.slice(Math.floor(samples.length / 2));
    const slope =
      half.length > 1
        ? (half.at(-1)!.rssMiB - half[0]!.rssMiB) / Math.max(0.1, half.at(-1)!.min - half[0]!.min)
        : 0;
    report.soak = { minutes, samples, rssSlopeMiBPerMinuteSecondHalf: +slope.toFixed(2) };
    console.log(`  RSS slope over the second half: ${slope.toFixed(2)} MiB/min (flat is about zero)`);
    socks.forEach((s) => s.ws.close());
  } finally {
    await stop(env);
  }
}

const which = arg.scenario;
if (which === "all" || which === "ws") await scenarioSockets();
if (which === "all" || which === "messages") await scenarioMessages();
if (which === "all" || which === "voice") await scenarioVoice();
if (which === "all" || which === "uploads") await scenarioUploads();
if (which === "soak") await scenarioSoak();
if (arg.json) (await import("node:fs")).writeFileSync(arg.json, JSON.stringify(report, null, 2));
console.log(`\nDone. Node ${process.version}, ${process.platform}.`);
process.exit(0);
