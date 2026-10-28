// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloseCode, Op } from "@tincan/shared";
import { OWNER, startTestServer, type TestServer, type TestSocket } from "../testing/harness.js";
import { handleConnection, type GatewayDeps } from "./connection.js";
import { GatewayHub } from "./hub.js";
import { RingBuffer } from "./ring.js";

const CLIENT = { name: "test", version: "1.0.0", platform: "node" };
let s: TestServer;
let token: string;
let userId: string;

beforeAll(async () => {
  s = await startTestServer({
    gateway: {
      heartbeatIntervalMs: 200,
      identifyTimeoutMs: 300,
      ringBufferEvents: 5,
      opBurst: 12,
      opPerSecond: 1,
    },
  });
  token = await s.setupOwner();
  userId = ((await s.request("GET", "/api/v1/users/@me", { token })).body as { id: string }).id;
});
afterAll(async () => {
  await s.close();
});

async function identified(opts: { query?: string } = {}): Promise<{ sock: TestSocket; sessionId: string }> {
  const sock = s.connect(opts.query);
  await sock.next((f) => f.op === Op.HELLO);
  sock.send({ op: Op.IDENTIFY, d: { token, client: CLIENT } });
  const ready = await sock.next((f) => f.t === "READY");
  return { sock, sessionId: (ready.d as { sessionId: string }).sessionId };
}

const beat = (sock: TestSocket) => sock.send({ op: Op.HEARTBEAT, d: null });

describe("lifecycle (07 §4.3)", () => {
  it("sends HELLO, then READY after IDENTIFY with a session token", async () => {
    const sock = s.connect();
    const hello = await sock.next();
    expect(hello).toMatchObject({ op: Op.HELLO, d: { heartbeatIntervalMs: 200, apiVersion: 1 } });
    sock.send({ op: Op.IDENTIFY, d: { token, client: CLIENT } });
    const ready = await sock.next((f) => f.t === "READY");
    expect(ready.s).toBe(0);
    expect(ready.d).toMatchObject({
      sessionId: expect.any(String),
      user: { id: userId, username: "mika", isInstanceOwner: true },
      instance: { name: "Friends of Tin" },
    });
    sock.close();
  });

  it("accepts a single-use ticket from the cookie session instead of a token", async () => {
    const t = await s.request("POST", "/api/v1/auth/gateway-ticket", {
      cookie: `tincan_session=${token}`,
      headers: { "x-tincan-csrf": "1" },
    });
    const ticket = (t.body as { ticket: string }).ticket;
    const a = s.connect();
    await a.next();
    a.send({ op: Op.IDENTIFY, d: { ticket, client: CLIENT } });
    await a.next((f) => f.t === "READY");
    a.close();
    const b = s.connect();
    await b.next();
    b.send({ op: Op.IDENTIFY, d: { ticket, client: CLIENT } });
    expect((await b.closed).code).toBe(CloseCode.AUTH_FAILED);
  });

  it("closes 4004 for a bad token", async () => {
    const sock = s.connect();
    await sock.next();
    sock.send({ op: Op.IDENTIFY, d: { token: "nope", client: CLIENT } });
    expect((await sock.closed).code).toBe(CloseCode.AUTH_FAILED);
  });

  it("closes 4003 when nothing is sent within the identify timeout, and for any op before IDENTIFY", async () => {
    const silent = s.connect();
    expect((await silent.closed).code).toBe(CloseCode.NOT_AUTHENTICATED);
    const eager = s.connect();
    await eager.next();
    beat(eager);
    expect((await eager.closed).code).toBe(CloseCode.NOT_AUTHENTICATED);
  });

  it("closes 4002 for malformed JSON and binary frames, 4001 for malformed frames and unknown ops", async () => {
    const bad = s.connect();
    await bad.next();
    bad.sendRaw("{not json");
    expect((await bad.closed).code).toBe(CloseCode.DECODE_ERROR);

    const bin = s.connect();
    await bin.next();
    bin.sendRaw(Buffer.from([1, 2, 3]));
    expect((await bin.closed).code).toBe(CloseCode.DECODE_ERROR);

    const shape = s.connect();
    await shape.next();
    shape.send({ op: "two" });
    expect((await shape.closed).code).toBe(CloseCode.INVALID_OPCODE);

    const { sock } = await identified();
    sock.send({ op: 99 });
    expect((await sock.closed).code).toBe(CloseCode.INVALID_OPCODE);
  });

  it("closes 4005 for a second IDENTIFY", async () => {
    const { sock } = await identified();
    sock.send({ op: Op.IDENTIFY, d: { token, client: CLIENT } });
    expect((await sock.closed).code).toBe(CloseCode.ALREADY_AUTHENTICATED);
  });

  it("acknowledges heartbeats and closes 4009 when they stop for two intervals", async () => {
    const { sock } = await identified();
    beat(sock);
    await sock.next((f) => f.op === Op.HEARTBEAT_ACK);
    expect((await sock.closed).code).toBe(CloseCode.SESSION_TIMED_OUT);
  });

  it("refuses an unsupported api version with 4011 after a HELLO", async () => {
    const sock = s.connect("?v=99&encoding=json");
    expect((await sock.next()).op).toBe(Op.HELLO);
    expect((await sock.closed).code).toBe(CloseCode.CLIENT_TOO_OLD);
  });

  it("refuses a browser origin that is not the instance's with 403 before the upgrade", async () => {
    const sock = s.connect("?v=1", { origin: "http://evil.example" });
    expect((await sock.closed).code).toBe(403);
    const ok = s.connect("?v=1", { origin: "http://localhost" });
    expect((await ok.next()).op).toBe(Op.HELLO);
    ok.close();
  });

  it("closes 1009 for a client frame over 64 KiB", async () => {
    const { sock } = await identified();
    sock.sendRaw("x".repeat(70 * 1024));
    // ws answers 1009 (message too big); the client side may see the connection reset first (1006)
    expect([1009, 1006]).toContain((await sock.closed).code);
  });

  it("closes 4008 when a socket exceeds its op budget", async () => {
    const { sock } = await identified();
    for (let i = 0; i < 40; i++) beat(sock);
    expect((await sock.closed).code).toBe(CloseCode.RATE_LIMITED);
  });

  it("closes the socket with 4004 when its login session is revoked", async () => {
    const login = await s.login("mika", OWNER.password);
    const t2 = (login.body as { token: string }).token;
    const sock = s.connect();
    await sock.next();
    sock.send({ op: Op.IDENTIFY, d: { token: t2, client: CLIENT } });
    await sock.next((f) => f.t === "READY");
    expect((await s.request("POST", "/api/v1/auth/logout", { token: t2 })).status).toBe(204);
    expect((await sock.closed).code).toBe(CloseCode.AUTH_FAILED);
  });
});

describe("dispatch and resume (07 §4.3, 05 §5)", () => {
  it("numbers events per session from 1, gap-free, only for that user", async () => {
    const { sock } = await identified();
    s.running.hub.dispatchToUser(userId, "TEST", { n: 1 });
    s.running.hub.dispatchToUser("someone-else", "TEST", { n: 99 });
    s.running.hub.dispatchToUser(userId, "TEST", { n: 2 });
    const a = await sock.next((f) => f.t === "TEST");
    const b = await sock.next((f) => f.t === "TEST");
    expect([a.s, b.s]).toEqual([1, 2]);
    expect([a.d, b.d]).toEqual([{ n: 1 }, { n: 2 }]);
    sock.close();
  });

  it("replays missed events in order on RESUME, then sends RESUMED", async () => {
    const { sock, sessionId } = await identified();
    s.running.hub.dispatchToUser(userId, "TEST", { n: 1 });
    s.running.hub.dispatchToUser(userId, "TEST", { n: 2 });
    await sock.next((f) => f.s === 2);
    sock.ws.terminate();
    await sock.closed;
    s.running.hub.dispatchToUser(userId, "TEST", { n: 3 });
    s.running.hub.dispatchToUser(userId, "TEST", { n: 4 });

    const again = s.connect();
    await again.next();
    again.send({ op: Op.RESUME, d: { token, sessionId, lastSeq: 2 } });
    const r1 = await again.next((f) => f.t === "TEST");
    const r2 = await again.next((f) => f.t === "TEST");
    expect([r1.s, r2.s]).toEqual([3, 4]);
    const resumed = await again.next((f) => f.t === "RESUMED");
    expect(resumed.d).toEqual({ replayed: 2 });
    // and the session is live again
    s.running.hub.dispatchToUser(userId, "TEST", { n: 5 });
    expect((await again.next((f) => f.t === "TEST")).s).toBe(5);
    again.close();
  });

  it("answers INVALID_SESSION {resumable:false} when the ring buffer no longer reaches back", async () => {
    const { sock, sessionId } = await identified();
    sock.ws.terminate();
    await sock.closed;
    for (let i = 1; i <= 9; i++) s.running.hub.dispatchToUser(userId, "TEST", { n: i }); // ring holds 5
    const again = s.connect();
    await again.next();
    again.send({ op: Op.RESUME, d: { token, sessionId, lastSeq: 1 } });
    const inv = await again.next((f) => f.op === Op.INVALID_SESSION);
    expect(inv.d).toEqual({ resumable: false });
    // the same socket can start over
    again.send({ op: Op.IDENTIFY, d: { token, client: CLIENT } });
    await again.next((f) => f.t === "READY");
    again.close();
  });

  it("answers INVALID_SESSION for an unknown session and closes 4007 for a sequence from the future", async () => {
    const a = s.connect();
    await a.next();
    a.send({ op: Op.RESUME, d: { token, sessionId: "does-not-exist", lastSeq: 0 } });
    expect((await a.next((f) => f.op === Op.INVALID_SESSION)).d).toEqual({ resumable: false });
    a.close();

    const { sock, sessionId } = await identified();
    sock.ws.terminate();
    await sock.closed;
    const b = s.connect();
    await b.next();
    b.send({ op: Op.RESUME, d: { token, sessionId, lastSeq: 50 } });
    expect((await b.closed).code).toBe(CloseCode.INVALID_SEQUENCE);
  });

  it("does not let another user resume a session", async () => {
    const { sock, sessionId } = await identified();
    sock.ws.terminate();
    await sock.closed;
    const { insertUser } = await import("../modules/accounts/users.js");
    const { hashPassword } = await import("@tincan/auth");
    await s.running.ports.db.transaction(async (tx) => {
      await insertUser(tx, {
        username: "eve",
        displayName: "Eve",
        passwordHash: await hashPassword("eve has a long password", {
          memoryKiB: 1024,
          timeCost: 1,
          parallelism: 1,
        }),
      });
    });
    const eve = ((await s.login("eve", "eve has a long password")).body as { token: string }).token;
    const thief = s.connect();
    await thief.next();
    thief.send({ op: Op.RESUME, d: { token: eve, sessionId, lastSeq: 0 } });
    expect((await thief.next((f) => f.op === Op.INVALID_SESSION)).d).toEqual({ resumable: false });
    thief.close();
  });
});

describe("commands (07 §4.6, 04 §7)", () => {
  it("runs registered commands, answers FEATURE_DISABLED for a module that is off and BAD_REQUEST for nonsense", async () => {
    const { sock } = await identified();
    sock.send({ op: Op.COMMAND, d: { cmd: "subscribe.channel", args: { channelId: "x" }, id: 1 } });
    expect((await sock.next((f) => f.op === Op.COMMAND_RESULT)).d).toEqual({ id: 1, ok: true });
    sock.send({ op: Op.COMMAND, d: { cmd: "voice.state", args: {}, id: 2 } });
    expect((await sock.next((f) => f.op === Op.COMMAND_RESULT)).d).toMatchObject({
      id: 2,
      ok: false,
      error: { code: "FEATURE_DISABLED" },
    });
    sock.send({ op: Op.COMMAND, d: { cmd: "rm -rf", id: 3 } });
    expect((await sock.next((f) => f.op === Op.COMMAND_RESULT)).d).toMatchObject({
      id: 3,
      ok: false,
      error: { code: "BAD_REQUEST" },
    });
    sock.close();
  });
});

describe("units", () => {
  it("RingBuffer keeps the newest events and drops old ones by count and by age", () => {
    const ring = new RingBuffer(3, 1000);
    for (let s = 1; s <= 5; s++) ring.push(s, `f${s}`, 0);
    expect(ring.size).toBe(3);
    expect(ring.since(2, 5, 10)).toEqual(["f3", "f4", "f5"]);
    expect(ring.since(1, 5, 10)).toBeNull();
    expect(ring.since(5, 5, 10)).toEqual([]);
    expect(ring.since(3, 5, 5000)).toBeNull(); // everything aged out
  });

  it("GatewayHub sweeps sessions that stayed detached past the replay window", () => {
    let now = 0;
    const hub = new GatewayHub({ ringBufferMs: 1000, now: () => now });
    const actor = { userId: "u", sessionId: "s", username: "u", displayName: "U", isInstanceOwner: false };
    const a = hub.create(actor);
    const b = hub.create(actor);
    a.detachedAt = 0;
    b.conn = { send: () => undefined, close: () => undefined };
    now = 1500;
    expect(hub.sweep()).toBe(1);
    expect(hub.sessions.has(a.id)).toBe(false);
    expect(hub.sessions.has(b.id)).toBe(true);
  });

  it("disconnects a slow consumer with the resumable close code 4010", async () => {
    const closes: [number, string][] = [];
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      sent: [] as string[],
      send(f: string) {
        this.sent.push(f);
      },
      close(code: number, reason: string) {
        closes.push([code, reason]);
        this.readyState = 3;
      },
      terminate: () => undefined,
    });
    const hub = new GatewayHub();
    const deps: GatewayDeps = {
      hub,
      authenticator: () => ({
        fromToken: () =>
          Promise.resolve({
            userId: "u",
            sessionId: "s",
            username: "u",
            displayName: "U",
            isInstanceOwner: false,
          }),
        fromTicket: () => Promise.resolve(null),
      }),
      log: { error: () => undefined, debug: () => undefined } as never,
      heartbeatIntervalMs: 10_000,
      identifyTimeoutMs: 10_000,
      maxSendQueueBytes: 1000,
    };
    handleConnection(socket as never, undefined, deps);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ op: Op.IDENTIFY, d: { token: "t", client: CLIENT } })),
      false,
    );
    await new Promise((r) => setTimeout(r, 20));
    const session = [...hub.sessions.values()][0]!;
    socket.bufferedAmount = 5000;
    hub.dispatchToSession(session, "TEST", { big: true });
    expect(closes[0]?.[0]).toBe(CloseCode.SLOW_CONSUMER);
    // the event is still buffered for a resume
    expect(session.ring.since(0, session.seq, Date.now())).toHaveLength(1);
    expect(session.conn).toBeNull();
  });
});
