// SPDX-License-Identifier: AGPL-3.0-or-later
import { Op, PERM, permissionsToString } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer, type TestSocket, type TestUser } from "../../testing/harness.js";

let s: TestServer;
let owner: string;
let ann: TestUser;
let bo: TestUser;
let general: string;
let lounge: string;
let everyoneRole: string;

const call = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
  put: (path: string, body?: unknown) => s.request("PUT", `/api/v1${path}`, { token, body }),
  patch: (path: string, body?: unknown) => s.request("PATCH", `/api/v1${path}`, { token, body }),
  del: (path: string) => s.request("DELETE", `/api/v1${path}`, { token }),
});

async function connect(token: string): Promise<TestSocket> {
  const sock = s.connect();
  await sock.next();
  sock.send({ op: Op.IDENTIFY, d: { token, client: { name: "t", version: "1", platform: "node" } } });
  await sock.next((f) => f.t === "READY");
  return sock;
}

beforeEach(async () => {
  s = await startTestServer({
    config: {
      modules: {
        accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
        "text-chat": { createRate: { max: 5, windowSecs: 10 } },
      },
    },
  });
  owner = await s.setupOwner();
  ann = await s.register("ann");
  bo = await s.register("bo");
  const channels = (await call(owner).get("/channels")).body.channels as { id: string; name: string }[];
  general = channels.find((c) => c.name === "general")!.id;
  lounge = channels.find((c) => c.name === "Lounge")!.id;
  everyoneRole = ((await call(owner).get("/roles")).body as { id: string; isDefault: boolean }[]).find(
    (r) => r.isDefault,
  )!.id;
});
afterEach(async () => {
  await s.close();
});

describe("messages", () => {
  it("creates, lists, edits and deletes a message, delivering events to viewers", async () => {
    const sock = await connect(bo.token);
    const created = await call(ann.token).post(`/channels/${general}/messages`, {
      content: "hello **world**",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      channelId: general,
      authorId: ann.id,
      content: "hello **world**",
      author: { username: "ann" },
      pinned: false,
      attachments: [],
      mentions: { users: [], roles: [], everyone: false },
    });
    const event = await sock.next((f) => f.t === "MESSAGE_CREATE");
    expect((event.d as any).message.id).toBe(created.body.id);

    const list = await call(bo.token).get(`/channels/${general}/messages`);
    expect(list.body.map((m: any) => m.content)).toEqual(["hello **world**"]);

    const edited = await call(ann.token).patch(`/channels/${general}/messages/${created.body.id}`, {
      content: "hello again",
    });
    expect(edited.body).toMatchObject({ content: "hello again" });
    expect(edited.body.editedAt).not.toBeNull();
    expect((await sock.next((f) => f.t === "MESSAGE_UPDATE")).d).toMatchObject({
      message: { content: "hello again" },
    });

    // Only the author edits; a plain member cannot delete someone else's message.
    expect(
      (await call(bo.token).patch(`/channels/${general}/messages/${created.body.id}`, { content: "x" }))
        .status,
    ).toBe(403);
    expect((await call(bo.token).del(`/channels/${general}/messages/${created.body.id}`)).status).toBe(403);
    expect((await call(ann.token).del(`/channels/${general}/messages/${created.body.id}`)).status).toBe(204);
    expect((await sock.next((f) => f.t === "MESSAGE_DELETE")).d).toMatchObject({
      messageId: created.body.id,
    });
    expect((await call(bo.token).get(`/channels/${general}/messages`)).body).toEqual([]);
    sock.close();
  });

  it("lets a moderator delete anyone's message", async () => {
    const mod = ((await call(owner).get("/roles")).body as { id: string; name: string }[]).find(
      (r) => r.name === "Moderator",
    )!;
    await call(owner).put(`/members/${bo.id}/roles/${mod.id}`);
    const m = await call(ann.token).post(`/channels/${general}/messages`, { content: "bad" });
    expect((await call(bo.token).del(`/channels/${general}/messages/${m.body.id}`)).status).toBe(204);
  });

  it("pages history with before, after and around, ascending, without gaps", async () => {
    const ids: string[] = [];
    // Create directly, ten at a time, to stay under the per-channel rate limit.
    for (let i = 0; i < 12; i++) {
      await s.running.ports.pubsub.kv.del(`rl:msg:${ann.id}:${general}`);
      ids.push((await call(ann.token).post(`/channels/${general}/messages`, { content: `m${i}` })).body.id);
    }
    const latest = (await call(bo.token).get(`/channels/${general}/messages?limit=5`)).body.map(
      (m: any) => m.content,
    );
    expect(latest).toEqual(["m7", "m8", "m9", "m10", "m11"]);
    const before = (
      await call(bo.token).get(`/channels/${general}/messages?limit=4&before=${ids[7]}`)
    ).body.map((m: any) => m.content);
    expect(before).toEqual(["m3", "m4", "m5", "m6"]);
    const after = (
      await call(bo.token).get(`/channels/${general}/messages?limit=3&after=${ids[3]}`)
    ).body.map((m: any) => m.content);
    expect(after).toEqual(["m4", "m5", "m6"]);
    const around = (
      await call(bo.token).get(`/channels/${general}/messages?limit=6&around=${ids[6]}`)
    ).body.map((m: any) => m.content);
    expect(around).toEqual(["m3", "m4", "m5", "m6", "m7", "m8"]);
    expect(
      (await call(bo.token).get(`/channels/${general}/messages?before=${ids[1]}&after=${ids[0]}`)).status,
    ).toBe(400);
    expect((await call(bo.token).get(`/channels/${general}/messages?limit=500`)).status).toBe(400);
  });

  it("is idempotent for a repeated nonce, and echoes the nonce", async () => {
    const first = await call(ann.token).post(`/channels/${general}/messages`, {
      content: "once",
      nonce: "n-1",
    });
    const again = await call(ann.token).post(`/channels/${general}/messages`, {
      content: "once",
      nonce: "n-1",
    });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(first.body.nonce).toBe("n-1");
    expect((await call(bo.token).get(`/channels/${general}/messages`)).body).toHaveLength(1);
    // Another user may reuse the nonce.
    expect(
      (await call(bo.token).post(`/channels/${general}/messages`, { content: "mine", nonce: "n-1" })).status,
    ).toBe(201);
  });

  it("handles simultaneous sends with one nonce as a single message", async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        call(ann.token).post(`/channels/${general}/messages`, { content: "race", nonce: "race" }),
      ),
    );
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await call(bo.token).get(`/channels/${general}/messages`)).body).toHaveLength(1);
  });

  it("validates content, replies and channel type", async () => {
    expect((await call(ann.token).post(`/channels/${general}/messages`, { content: "   " })).status).toBe(
      400,
    );
    const long = "x".repeat(4001);
    expect(
      (await call(ann.token).post(`/channels/${general}/messages`, { content: long })).body.error.code,
    ).toBe("VALIDATION_FAILED");
    expect(
      (
        await call(ann.token).post(`/channels/${general}/messages`, {
          content: "r",
          replyToId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        })
      ).status,
    ).toBe(400);
    expect((await call(ann.token).post(`/channels/${lounge}/messages`, { content: "voice" })).status).toBe(
      404,
    );
    expect((await call(ann.token).post(`/channels/nope/messages`, { content: "x" })).status).toBe(404);
  });

  it("hydrates replies and refuses replies across channels", async () => {
    const other = (await call(owner).post("/channels", { type: "text", name: "other" })).body.id;
    const a = await call(ann.token).post(`/channels/${general}/messages`, { content: "question?" });
    const r = await call(bo.token).post(`/channels/${general}/messages`, {
      content: "answer",
      replyToId: a.body.id,
    });
    expect(r.body.reply).toMatchObject({
      id: a.body.id,
      authorName: "ann",
      excerpt: "question?",
      deleted: false,
    });
    expect(
      (await call(bo.token).post(`/channels/${other}/messages`, { content: "x", replyToId: a.body.id }))
        .status,
    ).toBe(400);
    await call(ann.token).del(`/channels/${general}/messages/${a.body.id}`);
    const listed = (await call(bo.token).get(`/channels/${general}/messages`)).body[0];
    expect(listed.reply).toMatchObject({ deleted: true, excerpt: "" });
  });

  it("limits sends per user and channel (429 with retryAfterMs)", async () => {
    for (let i = 0; i < 5; i++)
      expect((await call(ann.token).post(`/channels/${general}/messages`, { content: `${i}` })).status).toBe(
        201,
      );
    const limited = await call(ann.token).post(`/channels/${general}/messages`, { content: "6" });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.body.error.details.retryAfterMs).toBeGreaterThan(0);
    // Another user, and another channel, are unaffected.
    expect((await call(bo.token).post(`/channels/${general}/messages`, { content: "ok" })).status).toBe(201);
  });

  it("applies slowmode to members but not to moderators", async () => {
    await call(owner).patch(`/channels/${general}`, { settings: { slowmodeSecs: 30 } });
    expect((await call(ann.token).post(`/channels/${general}/messages`, { content: "1" })).status).toBe(201);
    expect((await call(ann.token).post(`/channels/${general}/messages`, { content: "2" })).status).toBe(429);
    expect((await call(owner).post(`/channels/${general}/messages`, { content: "boss" })).status).toBe(201);
    expect((await call(owner).post(`/channels/${general}/messages`, { content: "boss2" })).status).toBe(201);
  });
});

describe("mentions", () => {
  it("records user, role and everyone mentions, and ignores what the author may not do", async () => {
    const mod = ((await call(owner).get("/roles")).body as { id: string; name: string }[]).find(
      (r) => r.name === "Moderator",
    )!;
    const text = `hi <@${bo.id}> and <@&${mod.id}> and <@01ARZ3NDEKTSV4RRFFQ69G5FAV> and @everyone`;
    const plain = await call(ann.token).post(`/channels/${general}/messages`, { content: text });
    expect(plain.body.mentions).toEqual({ users: [bo.id], roles: [mod.id], everyone: false }); // unknown user dropped, @everyone not allowed
    const boss = await call(owner).post(`/channels/${general}/messages`, { content: "@everyone dinner" });
    expect(boss.body.mentions.everyone).toBe(true);
    await call(ann.token).patch(`/channels/${general}/messages/${plain.body.id}`, {
      content: `now only <@${owner ? ann.id : ""}>`,
    });
    const after = (await call(bo.token).get(`/channels/${general}/messages`)).body.find(
      (m: any) => m.id === plain.body.id,
    );
    expect(after.mentions).toEqual({ users: [ann.id], roles: [], everyone: false });
  });
});

describe("pins", () => {
  it("lets moderators pin and unpin, listing pins", async () => {
    const m = await call(ann.token).post(`/channels/${general}/messages`, { content: "keep" });
    expect((await call(ann.token).put(`/channels/${general}/pins/${m.body.id}`)).status).toBe(403);
    const sock = await connect(bo.token);
    expect((await call(owner).put(`/channels/${general}/pins/${m.body.id}`)).status).toBe(204);
    expect((await sock.next((f) => f.t === "MESSAGE_PIN")).d).toMatchObject({
      messageId: m.body.id,
      pinned: true,
    });
    expect((await call(bo.token).get(`/channels/${general}/pins`)).body.map((x: any) => x.id)).toEqual([
      m.body.id,
    ]);
    expect((await call(bo.token).get(`/channels/${general}/messages`)).body[0].pinned).toBe(true);
    expect((await call(owner).del(`/channels/${general}/pins/${m.body.id}`)).status).toBe(204);
    expect((await call(bo.token).get(`/channels/${general}/pins`)).body).toEqual([]);
    sock.close();
  });
});

describe("permissions", () => {
  it("answers 404 for channels the member cannot see, 403 for missing rights, and empty history without READ_HISTORY", async () => {
    await call(owner).put(`/channels/${general}/overwrites/role/${everyoneRole}`, {
      allow: "0",
      deny: permissionsToString(PERM.VIEW_CHANNEL),
    });
    const hidden = await call(ann.token).get(`/channels/${general}/messages`);
    expect(hidden.status).toBe(404);
    expect((await call(ann.token).post(`/channels/${general}/messages`, { content: "x" })).status).toBe(404);
    expect((await call(ann.token).get(`/channels/${general}/pins`)).status).toBe(404);

    await call(owner).put(`/channels/${general}/overwrites/role/${everyoneRole}`, {
      allow: "0",
      deny: permissionsToString(PERM.SEND_MESSAGES),
    });
    const denied = await call(ann.token).post(`/channels/${general}/messages`, { content: "x" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.missing).toBe("SEND_MESSAGES");

    await call(owner).post(`/channels/${general}/messages`, { content: "old" });
    await call(owner).put(`/channels/${general}/overwrites/role/${everyoneRole}`, {
      allow: "0",
      deny: permissionsToString(PERM.READ_HISTORY),
    });
    expect((await call(ann.token).get(`/channels/${general}/messages`)).body).toEqual([]);
  });

  it("does not deliver events to members who cannot see the channel, and stops when access is withdrawn", async () => {
    const secret = (await call(owner).post("/channels", { type: "text", name: "secret" })).body.id;
    await call(owner).put(`/channels/${secret}/overwrites/role/${everyoneRole}`, {
      allow: "0",
      deny: permissionsToString(PERM.VIEW_CHANNEL),
    });
    const boSock = await connect(bo.token);
    const ownerSock = await connect(owner);
    await call(owner).post(`/channels/${secret}/messages`, { content: "classified" });
    await ownerSock.next((f) => f.t === "MESSAGE_CREATE");
    await call(owner).post(`/channels/${general}/messages`, { content: "public" });
    const got = await boSock.next((f) => f.t === "MESSAGE_CREATE");
    expect((got.d as any).message.content).toBe("public"); // the secret one never arrived
    expect(boSock.frames.filter((f) => f.t === "MESSAGE_CREATE")).toHaveLength(1);

    // Grant a role that can see it, then withdraw it: delivery follows the current permissions.
    const roleId = (await call(owner).post("/roles", { name: "Insiders" })).body.id;
    await call(owner).put(`/channels/${secret}/overwrites/role/${roleId}`, {
      allow: permissionsToString(PERM.VIEW_CHANNEL),
      deny: "0",
    });
    await call(owner).put(`/members/${bo.id}/roles/${roleId}`);
    await boSock.next((f) => f.t === "CHANNEL_CREATE");
    await call(owner).post(`/channels/${secret}/messages`, { content: "welcome" });
    expect(
      (await boSock.next((f) => f.t === "MESSAGE_CREATE" && (f.d as any).message.content === "welcome")).t,
    ).toBe("MESSAGE_CREATE");
    await call(owner).del(`/members/${bo.id}/roles/${roleId}`);
    await boSock.next((f) => f.t === "CHANNEL_DELETE");
    const before = boSock.frames.length;
    await call(owner).post(`/channels/${secret}/messages`, { content: "after removal" });
    await call(owner).post(`/channels/${general}/messages`, { content: "marker" });
    await boSock.next((f) => f.t === "MESSAGE_CREATE" && (f.d as any).message.content === "marker");
    expect(
      boSock.frames
        .slice(before)
        .some((f) => f.t === "MESSAGE_CREATE" && (f.d as any).message.content === "after removal"),
    ).toBe(false);
    boSock.close();
    ownerSock.close();
  });

  it("replays missed events on resume only for channels that were visible when they happened", async () => {
    const first = s.connect();
    await first.next();
    first.send({
      op: Op.IDENTIFY,
      d: { token: bo.token, client: { name: "t", version: "1", platform: "node" } },
    });
    const ready = (await first.next((f) => f.t === "READY")).d as { sessionId: string };
    first.close();
    await first.closed;
    await call(ann.token).post(`/channels/${general}/messages`, { content: "while you were away" });
    const again = s.connect();
    await again.next();
    again.send({ op: Op.RESUME, d: { token: bo.token, sessionId: ready.sessionId, lastSeq: 0 } });
    const replayed = await again.next((f) => f.t === "MESSAGE_CREATE");
    expect((replayed.d as any).message.content).toBe("while you were away");
    await again.next((f) => f.t === "RESUMED");
    again.close();
  });
});

describe("typing", () => {
  it("is delivered to others who can see the channel, rate limited, and gateway-only", async () => {
    const boSock = await connect(bo.token);
    const annSock = await connect(ann.token);
    annSock.send({ op: Op.COMMAND, d: { cmd: "typing.start", args: { channelId: general }, id: 1 } });
    const t = await boSock.next((f) => f.t === "TYPING_START");
    expect(t.d).toMatchObject({ channelId: general, userId: ann.id });
    annSock.send({ op: Op.COMMAND, d: { cmd: "typing.start", args: { channelId: general }, id: 2 } });
    expect((await annSock.next((f) => f.op === Op.COMMAND_RESULT && (f.d as any).id === 2)).d).toMatchObject({
      ok: true,
    });
    expect(boSock.frames.filter((f) => f.t === "TYPING_START")).toHaveLength(1); // coalesced
    expect(annSock.frames.some((f) => f.t === "TYPING_START")).toBe(false); // not echoed to the sender

    annSock.send({ op: Op.COMMAND, d: { cmd: "typing.start", args: { channelId: lounge }, id: 3 } });
    expect((await annSock.next((f) => f.op === Op.COMMAND_RESULT && (f.d as any).id === 3)).d).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect((await call(ann.token).post(`/channels/${general}/typing`)).status).toBe(404); // no REST route (18 T10)
    boSock.close();
    annSock.close();
  });
});

describe("module off", () => {
  it("leaves no routes behind when text-chat is disabled", async () => {
    const off = await startTestServer({
      config: {
        modules: {
          "text-chat": { enabled: false },
          "read-state": { enabled: false },
          search: { enabled: false },
        },
      },
    });
    try {
      const token = await off.setupOwner();
      const channels = (await off.request("GET", "/api/v1/channels", { token })).body.channels as {
        id: string;
      }[];
      expect(
        (await off.request("GET", `/api/v1/channels/${channels[0]!.id}/messages`, { token })).status,
      ).toBe(404);
    } finally {
      await off.close();
    }
  });
});
