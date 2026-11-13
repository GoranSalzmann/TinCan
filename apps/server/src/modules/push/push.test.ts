// SPDX-License-Identifier: AGPL-3.0-or-later
import { Op } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer, type TestUser } from "../../testing/harness.js";
import { senderOverride } from "./index.js";
import { deriveVapidKeys, endpointAllowed } from "./vapid.js";

let s: TestServer;
let owner: string;
let ann: TestUser;
let bo: TestUser;
let general: string;
let sent: { endpoint: string; payload: any; urgency: string; topic: string }[];
let failWith: number | null;

const api = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
  put: (path: string, body?: unknown) => s.request("PUT", `/api/v1${path}`, { token, body }),
  del: (path: string, body?: unknown) => s.request("DELETE", `/api/v1${path}`, { token, body }),
});
const sub = (n: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
  keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) },
});
const say = async (user: TestUser, content: string) => {
  await s.running.ports.pubsub.kv.del(`rl:msg:${user.id}:${general}`);
  const r = await api(user.token).post(`/channels/${general}/messages`, { content });
  expect(r.status).toBe(201);
  // The push handler runs after the response.
  await new Promise((r) => setTimeout(r, 50));
  return r.body.id as string;
};

beforeEach(async () => {
  sent = [];
  failWith = null;
  senderOverride.current = {
    async send(target, payload, o) {
      if (failWith) throw Object.assign(new Error("push failed"), { statusCode: failWith });
      sent.push({
        endpoint: target.endpoint,
        payload: JSON.parse(payload),
        urgency: o.urgency,
        topic: o.topic,
      });
    },
  };
  s = await startTestServer();
  owner = await s.setupOwner();
  ann = await s.register("ann");
  bo = await s.register("bo");
  const channels = (await api(owner).get("/channels")).body.channels as { id: string; name: string }[];
  general = channels.find((c) => c.name === "general")!.id;
});
afterEach(async () => {
  senderOverride.current = undefined;
  await s.close();
});

describe("push", () => {
  it("derives the same VAPID key from the same secret and a different one otherwise", () => {
    const a = deriveVapidKeys("x".repeat(40));
    expect(deriveVapidKeys("x".repeat(40))).toEqual(a);
    expect(deriveVapidKeys("y".repeat(40)).publicKey).not.toBe(a.publicKey);
    expect(Buffer.from(a.publicKey, "base64url")).toHaveLength(65);
  });

  it("accepts only known push services over https", () => {
    expect(endpointAllowed("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(endpointAllowed("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(endpointAllowed("http://fcm.googleapis.com/x")).toBe(false);
    expect(endpointAllowed("https://evilfcm.googleapis.com.example.org/x")).toBe(false);
    expect(endpointAllowed("https://127.0.0.1/x")).toBe(false);
    expect(endpointAllowed("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(endpointAllowed("https://u:p@fcm.googleapis.com/x")).toBe(false);
  });

  it("needs a login and refuses an unknown push service", async () => {
    expect((await s.request("GET", "/api/v1/push/vapid-key")).status).toBe(401);
    expect((await api(bo.token).get("/push/vapid-key")).body.publicKey).toBeTruthy();
    const bad = await api(bo.token).put("/push/subscription", {
      endpoint: "https://internal.example.org/hook",
      keys: sub("x").keys,
    });
    expect(bad.status).toBe(400);
  });

  it("pushes a message to an offline member, never to its author", async () => {
    expect((await api(bo.token).put("/push/subscription", sub("bo1"))).status).toBe(204);
    expect((await api(ann.token).put("/push/subscription", sub("ann1"))).status).toBe(204);
    await say(ann, "hello <@" + bo.id + ">");
    expect(sent.map((x) => x.endpoint)).toEqual([sub("bo1").endpoint]);
    expect(sent[0]!.payload).toMatchObject({ channelId: general, title: "ann in #general" });
    expect(sent[0]!.urgency).toBe("high");
    expect(sent[0]!.topic).toBe(general);
  });

  it("respects mentions-only and a timed mute, but a mention still gets through a mute", async () => {
    await api(bo.token).put("/push/subscription", sub("bo1"));
    await s.request("PATCH", "/api/v1/users/@me/settings", {
      token: bo.token,
      body: { "notifications.default": "mentions" },
    });
    await say(ann, "no mention");
    expect(sent).toHaveLength(0);
    await say(ann, `<@${bo.id}> ping`);
    expect(sent).toHaveLength(1);
    await s.request("PATCH", "/api/v1/users/@me/settings", {
      token: bo.token,
      body: {
        "notifications.default": "all",
        [`notifications.channel.${general}`]: { mutedUntil: Date.now() + 60_000 },
      },
    });
    await say(ann, "muted chatter");
    expect(sent).toHaveLength(1);
    await say(ann, `<@${bo.id}> still here`);
    expect(sent).toHaveLength(2);
  });

  it("skips members who cannot see the channel and those with a live socket", async () => {
    await api(bo.token).put("/push/subscription", sub("bo1"));
    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: bo.token, client: { name: "t", version: "1", platform: "node" } },
    });
    await sock.next((f) => f.t === "READY");
    await say(ann, "bo is looking");
    expect(sent).toHaveLength(0);
    sock.close();
  });

  it("pushes a nudge to an offline member, but not while they have a live socket", async () => {
    await api(bo.token).put("/push/subscription", sub("bo1"));
    const res = await api(ann.token).post(`/members/${bo.id}/nudge`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ online: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.map((x) => x.endpoint)).toEqual([sub("bo1").endpoint]);
    expect(sent[0]!.payload).toMatchObject({ tag: "nudge", title: "ann nudged you" });
    expect(sent[0]!.urgency).toBe("high");

    // A live socket already shows the nudge in the app; no push needed.
    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: bo.token, client: { name: "t", version: "1", platform: "node" } },
    });
    await sock.next((f) => f.t === "READY");
    await s.running.ports.pubsub.kv.del(`rl:nudge:pair:${ann.id}:${bo.id}`);
    const res2 = await api(ann.token).post(`/members/${bo.id}/nudge`);
    expect(res2.body).toEqual({ online: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
    sock.close();
  });

  it("drops a subscription the push service reports gone", async () => {
    await api(bo.token).put("/push/subscription", sub("bo1"));
    failWith = 410;
    await say(ann, "one");
    failWith = null;
    await say(ann, "two");
    expect(sent).toHaveLength(0);
  });

  it("unsubscribes, and moves an endpoint to the user who subscribed last", async () => {
    await api(bo.token).put("/push/subscription", sub("shared"));
    await api(ann.token).put("/push/subscription", sub("shared"));
    await say(bo, "to ann");
    expect(sent).toHaveLength(1);
    expect(
      (await api(ann.token).del("/push/subscription", { endpoint: sub("shared").endpoint })).status,
    ).toBe(204);
    await say(bo, "to nobody");
    expect(sent).toHaveLength(1);
  });
});
