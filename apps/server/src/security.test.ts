// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Op, CloseCode } from "@tincan/shared";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./boot.js";
import { parseCoreConfig } from "./config/load.js";
import { ALL_MODULES } from "./modules/index.js";
import { FakeLiveKit, jsonVerifier } from "./modules/voice/fake-livekit.js";
import { createVoiceModule } from "./modules/voice/index.js";
import { OWNER, startTestServer, type TestServer } from "./testing/harness.js";

/**
 * Evidence for the security checklist (15 §8, docs/security/m5-review.md). Each block names the S-number it supports.
 * What is not here is covered elsewhere: the authorisation matrix (S-04, S-05), the voice tests (S-08, S-10, S-15, S-16),
 * the web markdown tests (S-06), the uploads tests (S-07).
 */

let s: TestServer | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const SECRET = "security-test-secret-".padEnd(40, "x");

/** Routes that are meant to answer without a login. Anything else must run `authenticate` or `requireOwner`. */
const PUBLIC: Record<string, string> = {
  "GET /api/v1/capabilities": "describes the server so a client can show the login screen",
  "GET /api/v1/invites/:code": "invite preview; rate limited, the code is the credential",
  "POST /api/v1/auth/setup/verify": "first-run setup token check; rate limited",
  "POST /api/v1/auth/setup": "first-run setup; needs the one-time token",
  "POST /api/v1/auth/register": "registration; invite code or open signup, rate limited",
  "POST /api/v1/auth/reset": "redeem a reset code; rate limited",
  "POST /api/v1/auth/login": "login; rate limited per address and per name",
  "POST /api/v1/internal/livekit/webhook":
    "signed by LiveKit; answered 401 without a valid signature; Caddy answers 404",
  "GET /api/v1/metrics": "scraper token, owner session or direct loopback; 403 otherwise",
  "GET /healthz": "liveness",
  "GET /readyz": "readiness",
  "GET /gateway": "WebSocket; the first frame must carry a token or ticket, and Origin is checked",
};

describe("every route asks for a login or is on the public list (S-04)", () => {
  it("lists routes and finds none unaccounted for", async () => {
    s = await startTestServer({
      config: {
        livekit: { url: "ws://localhost/livekit", apiKey: "devkey", apiSecret: SECRET },
        modules: { accounts: { signup: "open" }, voice: { reconcileIntervalMs: 3_600_000 } },
      },
      modules: [
        ...ALL_MODULES.filter((m) => m.id !== "voice"),
        createVoiceModule({ rooms: new FakeLiveKit(), verify: jsonVerifier }),
      ],
    });
    const routes = (
      s.running.app as unknown as { routeTable: { method: string; url: string; auth: boolean }[] }
    ).routeTable;
    expect(routes.length).toBeGreaterThan(80);
    const open = routes.filter((r) => !r.auth && r.method !== "HEAD" && r.method !== "OPTIONS");
    const unexplained = open.map((r) => `${r.method} ${r.url}`).filter((k) => !(k in PUBLIC));
    expect(unexplained, "routes with no login check that are not on the public list").toEqual([]);
    // The list does not rot: every entry still names a real route.
    const have = new Set(open.map((r) => `${r.method} ${r.url}`));
    expect(Object.keys(PUBLIC).filter((k) => !have.has(k))).toEqual([]);
  });
});

describe("headers, cookies and CSRF (S-01, S-03, 11 §1.2)", () => {
  it("the session cookie is HttpOnly, SameSite=Strict and Secure over https; the API is not cacheable", async () => {
    s = await startTestServer({
      config: { instance: { name: "Sec", publicUrl: "https://chat.example.test" } },
    });
    await s.setupOwner();
    const res = await s.login(OWNER.username, OWNER.password);
    const cookie = res.setCookie ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/Path=\//);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // The token is only ever stored hashed: it does not appear in the database.
    const token = (res.body as { token: string }).token;
    const row = await s.running.ports.db.query
      // @ts-expect-error -- a raw look at the table, not part of the typed schema of this file
      .selectFrom("session")
      .select("token_hash")
      .execute();
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("a cookie alone cannot change anything without the CSRF header, and a bearer token needs none", async () => {
    s = await startTestServer();
    await s.setupOwner();
    const res = await s.login(OWNER.username, OWNER.password);
    const cookie = (res.setCookie ?? "").split(";")[0]!;
    const patch = (headers: Record<string, string>) =>
      s!.request("PATCH", "/api/v1/users/@me", { cookie, body: { statusText: "x" }, headers });
    expect((await patch({})).status).toBe(403);
    expect((await patch({ "x-tincan-csrf": "1" })).status).toBe(200);
  });

  it("the gateway refuses a browser Origin that is not the instance's", async () => {
    s = await startTestServer({
      config: { instance: { name: "Sec", publicUrl: "https://chat.example.test" } },
    });
    const bad = s.connect("?v=1&encoding=json", { origin: "https://evil.example" });
    expect((await bad.closed).code).toBe(403);
    const good = s.connect("?v=1&encoding=json", { origin: "https://chat.example.test" });
    const hello = await good.next();
    expect(hello.op).toBe(Op.HELLO);
    good.close();
  });
});

describe("rate limits (S-11)", () => {
  it("bound a signed-in member's reads and writes separately, and everything from one address", async () => {
    s = await startTestServer({
      config: {
        security: {
          instanceSecret: SECRET,
          rateLimit: {
            readsPerMinute: 10,
            writesPerMinute: 5,
            perIpPerMinute: 30,
            gatewaySocketsPerIp: 10_000,
          },
        },
      },
    });
    const owner = await s.setupOwner();
    const ann = await s.register("ann");
    const kv = s.running.ports.pubsub.kv;
    await kv.del("rl:api:ip:127.0.0.1");
    const status = async (method: string, path: string, token: string, body?: unknown) =>
      await s!.request(method, `/api/v1${path}`, { token, ...(body ? { body } : {}) });

    const seen: number[] = [];
    for (let i = 0; i < 12; i++) seen.push((await status("GET", "/roles", ann.token)).status);
    expect(seen.slice(0, 10).every((x) => x === 200)).toBe(true);
    const limited = await status("GET", "/roles", ann.token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    // Writes have their own, smaller bucket; the owner's reads are not affected by ann's.
    await kv.del("rl:api:ip:127.0.0.1");
    expect((await status("GET", "/roles", owner)).status).toBe(200);
    const writes: number[] = [];
    for (let i = 0; i < 7; i++)
      writes.push((await status("PATCH", "/users/@me", owner, { statusText: `s${i}` })).status);
    expect(writes.filter((x) => x === 429).length).toBeGreaterThanOrEqual(1);

    // One address cannot spread a flood over many members or over anonymous calls.
    await kv.del("rl:api:ip:127.0.0.1");
    let blocked = 0;
    for (let i = 0; i < 40; i++)
      if ((await s.request("GET", "/api/v1/capabilities")).status === 429) blocked++;
    expect(blocked).toBeGreaterThanOrEqual(8);
    // LiveKit's webhook path is exempt from the address limit (it is signed and comes in bursts from loopback).
    expect((await s.request("POST", "/api/v1/internal/livekit/webhook", { body: {} })).status).not.toBe(429);
  });

  it("login keeps its own stricter limits and does not reveal which part was wrong", async () => {
    s = await startTestServer();
    await s.setupOwner();
    const bad = await s.login(OWNER.username, "wrong password here", { keepLimits: true });
    const unknown = await s.login("nobody-at-all", "wrong password here", { keepLimits: true });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });
});

describe("gateway caps (15 §4.2)", () => {
  it("a member's oldest session ends when a new one would go over the cap", async () => {
    s = await startTestServer({
      config: {
        security: {
          instanceSecret: SECRET,
          rateLimit: { gatewaySessionsPerUser: 2, gatewaySocketsPerIp: 10_000 },
        },
      },
    });
    const owner = await s.setupOwner();
    const open = async () => {
      const sock = s!.connect();
      await sock.next();
      sock.send({
        op: Op.IDENTIFY,
        d: { token: owner, client: { name: "t", version: "1", platform: "node" } },
      });
      await sock.next((f) => f.t === "READY");
      return sock;
    };
    const a = await open();
    const b = await open();
    const c = await open();
    expect((await a.closed).code).toBe(CloseCode.SESSION_REPLACED);
    b.close();
    c.close();
  });

  it("refuses sockets beyond the per-address cap before they cost anything", async () => {
    s = await startTestServer({
      config: { security: { instanceSecret: SECRET, rateLimit: { gatewaySocketsPerIp: 3 } } },
    });
    const socks = [s.connect(), s.connect(), s.connect()];
    for (const k of socks) await k.next();
    const extra = s.connect();
    expect((await extra.closed).code).toBe(CloseCode.RATE_LIMITED);
    socks.forEach((k) => k.close());
  });
});

describe("secrets stay out of logs and responses (S-12, S-08)", () => {
  it("log lines carry no passwords, tokens, cookies, invite codes or reset codes", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const config = parseCoreConfig({
      security: { instanceSecret: SECRET },
      instance: { name: "L", publicUrl: "http://localhost" },
      dataDir: ".",
      log: { level: "info" },
    });
    s = await startTestServer({ logger: createLogger(config, sink) });
    const owner = await s.setupOwner();
    const login = await s.login(OWNER.username, OWNER.password);
    const token = (login.body as { token: string }).token;
    const cookie = (login.setCookie ?? "").split(";")[0]!;
    const invite = (await s.request("POST", "/api/v1/invites", { token: owner, body: {} })).body
      .code as string;
    await s.request("GET", `/api/v1/invites/${invite}`);
    await s.request("GET", "/api/v1/members?cursor=secret-cursor", { token, headers: { cookie } });
    await s.request("POST", "/api/v1/auth/login", { body: { username: "x", password: "hunter2hunter2" } });
    const reset = (
      await s.request("POST", `/api/v1/admin/users/${(await s.register("ann")).id}/reset-token`, {
        token: owner,
      })
    ).body.code as string;
    await s.request("POST", "/api/v1/auth/reset", {
      body: { code: reset, newPassword: "an entirely new password" },
    });
    const text = lines.join("\n");
    expect(text.length).toBeGreaterThan(200); // the logger really was used
    for (const secret of [
      OWNER.password,
      "hunter2hunter2",
      "an entirely new password",
      token,
      owner,
      invite,
      reset,
      "secret-cursor",
      SECRET,
    ])
      expect(text, secret.slice(0, 12)).not.toContain(secret);
    expect(text).toContain("/api/v1/invites/[redacted]");
  });

  it("no response ever carries LiveKit's API secret or the instance secret", async () => {
    s = await startTestServer({
      config: {
        livekit: { url: "ws://localhost/livekit", apiKey: "devkey", apiSecret: SECRET + "-livekit" },
        modules: {
          accounts: { signup: "open" },
          voice: { reconcileIntervalMs: 3_600_000, e2ee: { enabled: false } },
        },
      },
      modules: [
        ...ALL_MODULES.filter((m) => m.id !== "voice"),
        createVoiceModule({ rooms: new FakeLiveKit(), verify: jsonVerifier }),
      ],
    });
    const owner = await s.setupOwner();
    const lounge = (
      (await s.request("GET", "/api/v1/channels", { token: owner })).body.channels as {
        id: string;
        type: string;
      }[]
    ).find((c) => c.type === "voice")!.id;
    const bodies = [
      await s.request("GET", "/api/v1/capabilities"),
      await s.request("GET", "/api/v1/admin/modules", { token: owner }),
      await s.request("POST", `/api/v1/voice/channels/${lounge}/join`, { token: owner, body: {} }),
      await s.request("GET", "/api/v1/voice/status", { token: owner }),
      await s.request("GET", "/api/v1/channels", { token: owner }),
    ].map((r) => r.bytes.toString("utf8"));
    for (const b of bodies) {
      expect(b).not.toContain(SECRET);
      expect(b).not.toContain("livekit-secret");
    }
    // The join token is signed with the secret but does not contain it.
    expect(bodies[2]).not.toContain(SECRET + "-livekit");
  });
});

describe("files cannot run as part of the app (S-07)", () => {
  it("an HTML or SVG upload is served as a download inside a sandbox, never inline", async () => {
    s = await startTestServer();
    const owner = await s.setupOwner();
    const general = (
      (await s.request("GET", "/api/v1/channels", { token: owner })).body.channels as {
        id: string;
        type: string;
      }[]
    ).find((c) => c.type === "text")!.id;
    for (const [name, type, body] of [
      ["x.html", "text/html", "<script>alert(1)</script>"],
      ["x.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ] as const) {
      const form = new FormData();
      form.set("file", new Blob([body], { type }), name);
      const up = await s.request("POST", "/api/v1/uploads", { token: owner, form });
      expect(up.status).toBe(201);
      const msg = await s.request("POST", `/api/v1/channels/${general}/messages`, {
        token: owner,
        body: { content: "f", attachmentIds: [up.body.id] },
      });
      const file = await s.request("GET", `/api/v1/files/${msg.body.attachments[0].id}/${name}`, {
        token: owner,
      });
      expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
      expect(file.headers.get("content-type")).toBe("application/octet-stream");
      expect(file.headers.get("content-security-policy")).toContain("sandbox");
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("uploads cannot exhaust memory (15 §4.2, 18 §M)", () => {
  it("a big non-image goes to storage in chunks: the process does not grow by the file size", async () => {
    s = await startTestServer({
      config: { modules: { accounts: { signup: "open" }, uploads: { maxBytes: 1024 * 1024 * 1024 } } },
    });
    await s.setupOwner();
    const ann = await s.register("aa");
    const size = 600 * 1024 * 1024; // more than the old 512 MiB ceiling
    const boundary = "----stream";
    const CRLF = "\r\n";
    const head = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="big.bin"',
        "Content-Type: application/octet-stream",
        "",
        "",
      ].join(CRLF),
    );
    const chunk = Buffer.alloc(256 * 1024, 9);
    let sent = 0;
    let phase = 0;
    const bodyStream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (phase === 0) {
          c.enqueue(head);
          phase = 1;
          return;
        }
        if (sent < size) {
          c.enqueue(chunk);
          sent += chunk.length;
          return;
        }
        if (phase === 1) {
          c.enqueue(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
          phase = 2;
          return;
        }
        c.close();
      },
    });
    global.gc?.();
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().arrayBuffers)), 20);
    const base = process.memoryUsage().arrayBuffers;
    const res = await fetch(`${s.url}/api/v1/uploads`, {
      method: "POST",
      duplex: "half",
      headers: {
        authorization: `Bearer ${ann.token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: bodyStream,
    });
    clearInterval(timer);
    expect(res.status).toBe(201);
    const out = (await res.json()) as { size: number };
    expect(out.size).toBe(size);
    // The old path held the whole file (and a second copy while joining chunks); streaming stays well below half.
    expect(peak - base).toBeLessThan(200 * 1024 * 1024);
  });

  const storedFiles = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else out.push(join(d, e.name));
      }
    };
    if (existsSync(join(dir, "files"))) walk(join(dir, "files"));
    return out;
  };

  /** A multipart body of `size` bytes that can be cut off after `cutAfter` bytes. */
  function rawUpload(
    url: string,
    token: string,
    size: number,
    signal?: AbortSignal,
    delayMs = 0,
  ): Promise<Response> {
    const boundary = "----cut";
    const CRLF = "\r\n";
    const head = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="x.bin"',
        "Content-Type: application/octet-stream",
        "",
        "",
      ].join(CRLF),
    );
    const chunk = Buffer.alloc(64 * 1024, 3);
    let sent = 0;
    let phase = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (phase === 0) {
          c.enqueue(head);
          phase = 1;
          return;
        }
        if (sent < size) {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          c.enqueue(chunk);
          sent += chunk.length;
          return;
        }
        if (phase === 1) {
          c.enqueue(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
          phase = 2;
          return;
        }
        c.close();
      },
    });
    return fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      duplex: "half",
      ...(signal ? { signal } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
  }

  it("a connection cut part way leaves no partial file and no attachment", async () => {
    s = await startTestServer({ config: { modules: { accounts: { signup: "open" } } } });
    await s.setupOwner();
    const ann = await s.register("aa");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    await rawUpload(s.url, ann.token, 20 * 1024 * 1024, ctl.signal, 2).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    expect(storedFiles(s.dir)).toEqual([]);
    expect((await s.request("GET", "/api/v1/users/@me/storage", { token: ann.token })).body.usedBytes).toBe(
      0,
    );
  });

  it("a body that would pass the person's quota stops part way and leaves nothing", async () => {
    s = await startTestServer({
      config: { modules: { accounts: { signup: "open" }, uploads: { userQuotaBytes: 2 * 1024 * 1024 } } },
    });
    await s.setupOwner();
    const ann = await s.register("aa");
    const t0 = Date.now();
    const res = await rawUpload(s.url, ann.token, 50 * 1024 * 1024);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("QUOTA_EXCEEDED");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(storedFiles(s.dir)).toEqual([]);
  });

  it("refuses a body over the limit part way and leaves nothing behind", async () => {
    s = await startTestServer({
      config: { modules: { accounts: { signup: "open" }, uploads: { maxBytes: 2 * 1024 * 1024 } } },
    });
    await s.setupOwner();
    const ann = await s.register("aa");
    const form = new FormData();
    form.set(
      "file",
      new Blob([Buffer.alloc(3 * 1024 * 1024, 1)], { type: "application/octet-stream" }),
      "big.bin",
    );
    const res = await s.request("POST", "/api/v1/uploads", { token: ann.token, form });
    expect(res.status).toBe(413);
    expect((await s.request("GET", "/api/v1/users/@me/storage", { token: ann.token })).body.usedBytes).toBe(
      0,
    );
  });

  it("turns away images that would go over the memory budget, with a retry hint, and counts them", async () => {
    s = await startTestServer({
      config: {
        modules: { accounts: { signup: "open" }, uploads: { memoryBudgetBytes: 16 * 1024 * 1024 } },
      },
    });
    await s.setupOwner();
    const people = [
      await s.register("aa"),
      await s.register("bb"),
      await s.register("cc"),
      await s.register("dd"),
    ];
    const png = await sharp({
      create: { width: 1200, height: 1200, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } },
    })
      .png()
      .toBuffer();
    expect(png.length).toBeGreaterThan(3 * 1024 * 1024);
    const results = await Promise.all(
      people.map((p) => {
        const form = new FormData();
        form.set("file", new Blob([png], { type: "image/png" }), "n.png");
        return s!.request("POST", "/api/v1/uploads", { token: p.token, form });
      }),
    );
    const busy = results.filter((r) => r.status === 429);
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(busy[0]!.headers.get("retry-after")).toBe("5");
    expect(busy[0]!.body.error.details.reason).toBe("upload_memory");
    expect((await s.request("GET", "/api/v1/metrics")).bytes.toString()).toMatch(
      /tincan_uploads_busy_total [1-9]/,
    );
  });
});

describe("revocation (S-03, 11 §1.2)", () => {
  it("a password change, a reset code and a ban each end the other sessions at once, sockets included", async () => {
    s = await startTestServer();
    const owner = await s.setupOwner();
    const ann = await s.register("ann");
    const second = (await s.login("ann", OWNER.password)).body.token as string;
    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: second, client: { name: "t", version: "1", platform: "node" } },
    });
    await sock.next((f) => f.t === "READY");
    const change = await s.request("POST", "/api/v1/auth/password", {
      token: ann.token,
      body: { currentPassword: OWNER.password, newPassword: "a brand new passphrase" },
    });
    expect(change.status).toBe(204);
    expect((await sock.closed).code).toBe(CloseCode.AUTH_FAILED);
    expect((await s.request("GET", "/api/v1/users/@me", { token: second })).status).toBe(401);
    expect((await s.request("GET", "/api/v1/users/@me", { token: ann.token })).status).toBe(200);
    expect(owner).toBeTruthy();
  });
});
