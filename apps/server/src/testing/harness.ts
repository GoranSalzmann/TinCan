// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { boot, type BootOptions, type RunningApp } from "../boot.js";
import { parseCoreConfig } from "../config/load.js";
import type { CoreConfig } from "../config/schema.js";

export const OWNER = { username: "mika", displayName: "Mika", password: "correct horse battery staple" };

export interface TestServer {
  running: RunningApp;
  dir: string;
  url: string;
  wsUrl: string;
  setupToken(): string;
  request(method: string, path: string, opts?: ReqOptions): Promise<TestResponse>;
  /** Creates the owner through the real setup flow and returns its session token. */
  setupOwner(): Promise<string>;
  /** Registers a member through the real endpoint (the harness config allows open signup) and returns their login. */
  register(username: string, opts?: { displayName?: string; inviteCode?: string }): Promise<TestUser>;
  /** Clears the per-IP login counter first, so suites that log in often are not throttled; pass `keepLimits` to test throttling. */
  login(username: string, password: string, opts?: { keepLimits?: boolean }): Promise<TestResponse>;
  connect(query?: string, headers?: Record<string, string>): TestSocket;
  close(): Promise<void>;
}

export interface TestUser {
  id: string;
  username: string;
  token: string;
}

export interface ReqOptions {
  body?: unknown;
  token?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

export interface TestResponse {
  status: number;
  body: any;
  headers: Headers;
  setCookie: string | null;
}

export interface TestSocket {
  ws: WebSocket;
  /** Every frame received so far, parsed. */
  frames: { op: number; t?: string; s?: number; d?: unknown }[];
  closed: Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
  sendRaw(data: string | Buffer): void;
  next(
    match?: (f: TestSocket["frames"][number]) => boolean,
    timeoutMs?: number,
  ): Promise<TestSocket["frames"][number]>;
  close(): void;
}

export async function startTestServer(
  opts: {
    config?: Record<string, unknown>;
    modules?: BootOptions["modules"];
    gateway?: BootOptions["gateway"];
  } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "tincan-srv-"));
  const raw = {
    security: { instanceSecret: "test-secret-".padEnd(40, "x") },
    instance: { name: "Test Place", publicUrl: "http://localhost" },
    dataDir: dir,
    adapters: {
      database: { kind: "sqlite", path: join(dir, "app.db") },
      storage: { kind: "local", path: join(dir, "files") },
    },
    server: { host: "127.0.0.1", port: 0 },
    log: { level: "silent" },
    modules: { accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } } },
    ...opts.config,
  };
  const config: CoreConfig = parseCoreConfig(raw);
  const running = await boot({
    config,
    ...(opts.modules ? { modules: opts.modules } : {}),
    ...(opts.gateway ? { gateway: opts.gateway } : {}),
  });
  const url = running.address!;
  const wsUrl = url.replace(/^http/, "ws");

  const request: TestServer["request"] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.cookie = o.cookie;
    const res = await fetch(url + path, {
      method,
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text ? (JSON.parse(text) as unknown) : null,
      headers: res.headers,
      setCookie: res.headers.get("set-cookie"),
    };
  };

  const server: TestServer = {
    running,
    dir,
    url,
    wsUrl,
    setupToken: () => readFileSync(join(dir, "setup-token"), "utf8").trim(),
    request,
    async setupOwner() {
      const res = await request("POST", "/api/v1/auth/setup", {
        body: { token: server.setupToken(), ...OWNER, instanceName: "Friends of Tin" },
      });
      if (res.status !== 200) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
      return (res.body as { token: string }).token;
    },
    async register(username, o = {}) {
      await running.ports.pubsub.kv.del("rl:register:ip:127.0.0.1");
      const res = await request("POST", "/api/v1/auth/register", {
        body: {
          username,
          displayName: o.displayName ?? username,
          password: OWNER.password,
          ...(o.inviteCode ? { inviteCode: o.inviteCode } : {}),
        },
      });
      if (res.status !== 200) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
      const body = res.body as { token: string; user: { id: string } };
      return { id: body.user.id, username, token: body.token };
    },
    async login(username, password, opts = {}) {
      if (!opts.keepLimits) await running.ports.pubsub.kv.del("rl:login:ip:127.0.0.1");
      return request("POST", "/api/v1/auth/login", { body: { username, password } });
    },
    connect(query = "?v=1&encoding=json", headers) {
      const ws = new WebSocket(`${wsUrl}/gateway${query}`, { headers });
      const frames: TestSocket["frames"] = [];
      const waiters: (() => void)[] = [];
      ws.on("message", (data) => {
        frames.push(JSON.parse(String(data)) as TestSocket["frames"][number]);
        for (const w of waiters.splice(0)) w();
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("close", (code, reason) => resolve({ code, reason: String(reason) }));
        ws.on("error", () => undefined);
        ws.on("unexpected-response", (_req, res) => resolve({ code: res.statusCode ?? 0, reason: "http" }));
      });
      let cursor = 0;
      return {
        ws,
        frames,
        closed,
        send: (f) => ws.send(JSON.stringify(f)),
        sendRaw: (d) => ws.send(d),
        close: () => ws.close(),
        async next(match = () => true, timeoutMs = 3000) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            while (cursor < frames.length) {
              const f = frames[cursor++]!;
              if (match(f)) return f;
            }
            const left = deadline - Date.now();
            if (left <= 0) throw new Error(`timed out waiting for a frame; got ${JSON.stringify(frames)}`);
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, left);
              waiters.push(() => {
                clearTimeout(t);
                resolve();
              });
            });
          }
        },
      };
    },
    async close() {
      await running.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
  return server;
}
