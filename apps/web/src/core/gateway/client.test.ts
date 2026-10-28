// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { CloseCode, Op } from "@tincan/shared";
import { GatewayClient, gatewayUrl, type GatewayState, type SocketLike } from "./client.js";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: { op: number; d: Record<string, unknown> | number | null }[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  closedWith: number | null = null;

  send(data: string) {
    this.sent.push(JSON.parse(data) as FakeSocket["sent"][number]);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.serverClose(code);
  }
  open() {
    this.readyState = 1;
  }
  serverSend(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

function harness(overrides: { backoff?: { minMs: number; maxMs: number } } = {}) {
  const sockets: FakeSocket[] = [];
  const states: GatewayState[] = [];
  const dispatches: [string, unknown, number][] = [];
  const timers: { fn: () => void; ms: number; id: number; cleared: boolean }[] = [];
  let tickets = 0;
  const client = new GatewayClient({
    url: "ws://x/gateway",
    getCredentials: () => Promise.resolve({ ticket: `ticket-${++tickets}` }),
    client: { name: "test", version: "1", platform: "web" },
    onState: (s) => states.push(s),
    onDispatch: (t, d, s) => dispatches.push([t, d, s]),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      s.open();
      return s;
    },
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length, cleared: false };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const t = timers[id as number];
      if (t) t.cleared = true;
    },
    ...overrides,
  });
  const live = () => timers.filter((t) => !t.cleared);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { client, sockets, states, dispatches, timers, live, flush };
}

const hello = { op: Op.HELLO, d: { heartbeatIntervalMs: 1000, apiVersion: 1 } };
const ready = (sessionId = "S1") => ({ op: Op.DISPATCH, t: "READY", s: 0, d: { sessionId } });

describe("GatewayClient", () => {
  it("builds the gateway URL from the page origin", () => {
    expect(gatewayUrl({ protocol: "https:", host: "chat.example.com" })).toBe(
      "wss://chat.example.com/gateway?v=1&encoding=json",
    );
    expect(gatewayUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/gateway?v=1&encoding=json",
    );
  });

  it("identifies with a fresh ticket after HELLO and becomes ready on READY", async () => {
    const h = harness();
    h.client.connect();
    expect(h.client.state).toBe("connecting");
    h.sockets[0]!.serverSend(hello);
    await h.flush();
    expect(h.sockets[0]!.sent[0]).toMatchObject({
      op: Op.IDENTIFY,
      d: { ticket: "ticket-1", client: { name: "test", version: "1", platform: "web" } },
    });
    h.sockets[0]!.serverSend(ready());
    expect(h.client.state).toBe("ready");
    expect(h.client.sessionId).toBe("S1");
  });

  it("heartbeats at a jittered interval with the last sequence number, and treats the ack as proof of life", async () => {
    const h = harness();
    h.client.connect();
    h.sockets[0]!.serverSend(hello);
    await h.flush();
    h.sockets[0]!.serverSend(ready());
    h.sockets[0]!.serverSend({ op: Op.DISPATCH, t: "X", s: 1, d: {} });
    h.sockets[0]!.serverSend({ op: Op.DISPATCH, t: "X", s: 2, d: {} });

    const first = h.live().at(-1)!;
    expect(first.ms).toBe(500); // interval × random()
    first.fn();
    expect(h.sockets[0]!.sent.at(-1)).toEqual({ op: Op.HEARTBEAT, d: 2 });
    h.sockets[0]!.serverSend({ op: Op.HEARTBEAT_ACK, d: null });
    const second = h.live().at(-1)!;
    expect(second.ms).toBe(1000);
    second.fn();
    expect(h.sockets[0]!.closedWith).toBeNull(); // acked, so fine
  });

  it("closes the connection when a heartbeat was never acknowledged", async () => {
    const h = harness();
    h.client.connect();
    h.sockets[0]!.serverSend(hello);
    await h.flush();
    h.sockets[0]!.serverSend(ready());
    h.live().at(-1)!.fn(); // beat, no ack
    h.live().at(-1)!.fn(); // next tick: still unacknowledged
    expect(h.sockets[0]!.closedWith).toBe(CloseCode.NORMAL);
    expect(h.client.state).toBe("reconnecting");
  });

  it("reconnects with backoff and resumes from the last sequence number", async () => {
    const h = harness({ backoff: { minMs: 1000, maxMs: 30_000 } });
    h.client.connect();
    h.sockets[0]!.serverSend(hello);
    await h.flush();
    h.sockets[0]!.serverSend(ready("S9"));
    h.sockets[0]!.serverSend({ op: Op.DISPATCH, t: "X", s: 1, d: {} });
    h.sockets[0]!.serverSend({ op: Op.DISPATCH, t: "X", s: 2, d: {} });
    h.sockets[0]!.serverClose(1006);
    expect(h.client.state).toBe("reconnecting");

    const retry = h.live().at(-1)!;
    expect(retry.ms).toBe(750); // base 1000 → half fixed + half × random(0.5)
    retry.fn();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.serverSend(hello);
    await h.flush();
    expect(h.sockets[1]!.sent[0]).toMatchObject({
      op: Op.RESUME,
      d: { ticket: "ticket-2", sessionId: "S9", lastSeq: 2 },
    });
    h.sockets[1]!.serverSend({ op: Op.DISPATCH, t: "RESUMED", s: 2, d: { replayed: 0 } });
    expect(h.client.state).toBe("ready");
  });

  it("doubles the wait on repeated failures up to the cap", () => {
    const h = harness({ backoff: { minMs: 1000, maxMs: 4000 } });
    h.client.connect();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      h.sockets.at(-1)!.serverClose(1006);
      const t = h.live().at(-1)!;
      delays.push(t.ms);
      t.fn();
    }
    expect(delays).toEqual([750, 1500, 3000, 3000, 3000]);
  });

  it("starts over with IDENTIFY on INVALID_SESSION", async () => {
    const h = harness();
    h.client.connect();
    h.sockets[0]!.serverSend(hello);
    await h.flush();
    h.sockets[0]!.serverSend(ready("OLD"));
    h.sockets[0]!.serverClose(1006);
    h.live().at(-1)!.fn();
    h.sockets[1]!.serverSend(hello);
    await h.flush();
    expect(h.sockets[1]!.sent[0]?.op).toBe(Op.RESUME);
    h.sockets[1]!.serverSend({ op: Op.INVALID_SESSION, d: { resumable: false } });
    await h.flush();
    expect(h.sockets[1]!.sent[1]).toMatchObject({ op: Op.IDENTIFY, d: { ticket: "ticket-3" } });
    expect(h.client.sessionId).toBeNull();
  });

  it("does not reconnect after the server revoked the login (4004), and reports it", () => {
    const h = harness();
    h.client.connect();
    h.sockets[0]!.serverClose(CloseCode.AUTH_FAILED);
    expect(h.client.state).toBe("unauthenticated");
    expect(h.live().filter((t) => t.ms > 0 && !t.cleared)).toHaveLength(0);
  });

  it("stops on 4011 and on an HELLO with another api version", async () => {
    const a = harness();
    a.client.connect();
    a.sockets[0]!.serverClose(CloseCode.CLIENT_TOO_OLD);
    expect(a.client.state).toBe("too-old");

    const b = harness();
    b.client.connect();
    b.sockets[0]!.serverSend({ op: Op.HELLO, d: { heartbeatIntervalMs: 1000, apiVersion: 2 } });
    await b.flush();
    expect(b.client.state).toBe("too-old");
    expect(b.sockets[0]!.sent).toEqual([]);
  });

  it("closes cleanly on disconnect() and does not reconnect", () => {
    const h = harness();
    h.client.connect();
    h.client.disconnect();
    expect(h.client.state).toBe("closed");
    expect(h.sockets[0]!.closedWith).toBe(CloseCode.NORMAL);
    expect(h.sockets).toHaveLength(1);
  });

  it("reconnects when the server sends RECONNECT", async () => {
    const h = harness();
    h.client.connect();
    h.sockets[0]!.serverSend(hello);
    await h.flush();
    h.sockets[0]!.serverSend(ready());
    h.sockets[0]!.serverSend({ op: Op.RECONNECT, d: null });
    expect(h.sockets[0]!.closedWith).toBe(CloseCode.GOING_AWAY);
    expect(h.client.state).toBe("reconnecting");
  });

  it("passes dispatches to the listener with their sequence number", async () => {
    const h = harness();
    h.client.connect();
    h.sockets[0]!.serverSend(hello);
    await h.flush();
    h.sockets[0]!.serverSend(ready());
    h.sockets[0]!.serverSend({ op: Op.DISPATCH, t: "MESSAGE_CREATE", s: 1, d: { id: "m" } });
    expect(h.dispatches.at(-1)).toEqual(["MESSAGE_CREATE", { id: "m" }, 1]);
  });
});
