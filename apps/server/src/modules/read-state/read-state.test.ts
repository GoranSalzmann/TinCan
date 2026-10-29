// SPDX-License-Identifier: AGPL-3.0-or-later
import { Op, PERM, permissionsToString } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer, type TestUser } from "../../testing/harness.js";

let s: TestServer;
let owner: string;
let ann: TestUser;
let bo: TestUser;
let general: string;

const call = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
  put: (path: string, body?: unknown) => s.request("PUT", `/api/v1${path}`, { token, body }),
});

beforeEach(async () => {
  s = await startTestServer();
  owner = await s.setupOwner();
  ann = await s.register("ann");
  bo = await s.register("bo");
  const channels = (await call(owner).get("/channels")).body.channels as { id: string; name: string }[];
  general = channels.find((c) => c.name === "general")!.id;
});
afterEach(async () => {
  await s.close();
});

const say = async (token: string, content: string) => {
  const sender = token === ann.token ? ann.id : bo.id;
  await s.running.ports.pubsub.kv.del(`rl:msg:${sender}:${general}`);
  return (await call(token).post(`/channels/${general}/messages`, { content })).body.id as string;
};
const entry = async (token: string) =>
  ((await call(token).get("/read-state")).body as any[]).find((e) => e.channelId === general);

describe("read state", () => {
  it("starts unread, tracks the newest message and clears on ack", async () => {
    expect(await entry(bo.token)).toMatchObject({ lastReadId: null, latestMessageId: null, mentionCount: 0 });
    const m1 = await say(ann.token, "one");
    const m2 = await say(ann.token, "two");
    expect(await entry(bo.token)).toMatchObject({ lastReadId: null, latestMessageId: m2 });
    const acked = await call(bo.token).post(`/channels/${general}/ack`, { messageId: m1 });
    expect(acked.body).toMatchObject({ lastReadId: m1, latestMessageId: m2 });
    expect((await call(bo.token).post(`/channels/${general}/ack`, { messageId: m2 })).body.lastReadId).toBe(
      m2,
    );
  });

  it("never moves backwards: a stale device cannot un-read", async () => {
    const m1 = await say(ann.token, "one");
    const m2 = await say(ann.token, "two");
    await call(bo.token).post(`/channels/${general}/ack`, { messageId: m2 });
    const stale = await call(bo.token).post(`/channels/${general}/ack`, { messageId: m1 });
    expect(stale.status).toBe(200);
    expect(stale.body.lastReadId).toBe(m2);
  });

  it("clamps an ID from the future to the newest message", async () => {
    const m1 = await say(ann.token, "one");
    const ack = await call(bo.token).post(`/channels/${general}/ack`, {
      messageId: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    });
    expect(ack.body.lastReadId).toBe(m1);
  });

  it("counts mentions of the user, their roles and @everyone after the read position, and recounts after deletes", async () => {
    const mod = ((await call(owner).get("/roles")).body as any[]).find((r) => r.name === "Moderator");
    await call(owner).put(`/members/${bo.id}/roles/${mod.id}`);
    const a = await say(ann.token, `hey <@${bo.id}>`);
    await say(ann.token, `mods <@&${mod.id}>`);
    await call(owner).post(`/channels/${general}/messages`, { content: "@everyone news" });
    await say(ann.token, "nothing for you");
    expect((await entry(bo.token)).mentionCount).toBe(3);
    expect((await entry(ann.token)).mentionCount).toBe(1); // only @everyone

    await call(bo.token).post(`/channels/${general}/ack`, { messageId: a });
    expect((await entry(bo.token)).mentionCount).toBe(2);
  });

  it("syncs the user's other devices with READ_STATE_UPDATE and puts state in READY", async () => {
    const m1 = await say(ann.token, "one");
    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: bo.token, client: { name: "t", version: "1", platform: "node" } },
    });
    const ready = (await sock.next((f) => f.t === "READY")).d as any;
    expect(ready.readState.find((e: any) => e.channelId === general)).toMatchObject({
      latestMessageId: m1,
      lastReadId: null,
    });
    await call(bo.token).post(`/channels/${general}/ack`, { messageId: m1 });
    expect((await sock.next((f) => f.t === "READ_STATE_UPDATE")).d).toMatchObject({
      channelId: general,
      lastReadId: m1,
    });
    sock.close();
  });

  it("hides channels the user cannot see", async () => {
    const everyone = ((await call(owner).get("/roles")).body as any[]).find((r) => r.isDefault);
    await call(owner).put(`/channels/${general}/overwrites/role/${everyone.id}`, {
      allow: "0",
      deny: permissionsToString(PERM.VIEW_CHANNEL),
    });
    expect(await entry(bo.token)).toBeUndefined();
    expect(
      (await call(bo.token).post(`/channels/${general}/ack`, { messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }))
        .status,
    ).toBe(404);
  });
});
