// SPDX-License-Identifier: AGPL-3.0-or-later
import { Op, voiceRoomName } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MODULES } from "./modules/index.js";
import { FakeLiveKit, jsonVerifier } from "./modules/voice/fake-livekit.js";
import { createVoiceModule } from "./modules/voice/index.js";
import type { LkWebhookEvent } from "./modules/voice/livekit.js";
import { startTestServer, type TestServer, type TestSocket } from "./testing/harness.js";

/**
 * Moderation, the audit log and voice E2EE rotation (11 §2.4, §2.6, §3; 10 §4.3), end to end against the fake LiveKit.
 * The roles: owner > admin (Admin role) > mod (Moderator role) > members. Hierarchy is by role position.
 */
const KEY = "devkey";
const SECRET = "mod-test-secret-".padEnd(40, "x");

let s: TestServer;
let fake: FakeLiveKit;
let owner: string;
let lounge: string;
let second: string;
let admin: { id: string; token: string };
let mod: { id: string; token: string };
let mod2: { id: string; token: string };
let ann: { id: string; token: string };
let bo: { id: string; token: string };

const api = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body: body ?? {} }),
  put: (path: string, body?: unknown) => s.request("PUT", `/api/v1${path}`, { token, body: body ?? {} }),
  patch: (path: string, body?: unknown) => s.request("PATCH", `/api/v1${path}`, { token, body }),
  del: (path: string) => s.request("DELETE", `/api/v1${path}`, { token }),
});

let seq = 0;
const webhook = (kind: string, userId: string, sid: string, channel = lounge) => {
  const e: LkWebhookEvent = {
    id: `EV_${++seq}`,
    event: kind,
    createdAt: Math.floor(Date.now() / 1000),
    room: { name: voiceRoomName(channel), sid: "RM_x" },
    participant: { identity: userId, sid },
    track: null,
  };
  return fetch(`${s.url}/api/v1/internal/livekit/webhook`, {
    method: "POST",
    headers: { "content-type": "application/webhook+json", authorization: "ok" },
    body: JSON.stringify(e),
  });
};

/** Joins through the real endpoint and tells the app the participant arrived, as LiveKit's webhook would. */
async function enterVoice(u: { id: string; token: string }, channel = lounge, e2ee = true) {
  const res = await api(u.token).post(`/voice/channels/${channel}/join`, { e2ee });
  expect(res.status).toBe(200);
  fake.connect(voiceRoomName(channel), u.id, { sid: `PA_${u.id}` });
  await webhook("participant_joined", u.id, `PA_${u.id}`, channel);
  return res.body as { e2ee: { epoch: number; keyIndex: number; key: string } | null };
}

async function identified(token: string): Promise<TestSocket> {
  const sock = s.connect();
  await sock.next();
  sock.send({ op: Op.IDENTIFY, d: { token, client: { name: "t", version: "1", platform: "node" } } });
  await sock.next((f) => f.t === "READY");
  return sock;
}

const inVoice = async (channel = lounge) =>
  ((await api(owner).get("/voice/state")).body.voice[channel] ?? []) as { userId: string }[];

beforeEach(async () => {
  fake = new FakeLiveKit();
  s = await startTestServer({
    config: {
      livekit: { url: "ws://localhost/livekit", apiKey: KEY, apiSecret: SECRET },
      modules: {
        accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
        voice: { reconcileIntervalMs: 3_600_000 },
        moderation: { timeoutCheckMs: 100 },
      },
    },
    modules: [
      ...ALL_MODULES.filter((m) => m.id !== "voice"),
      createVoiceModule({ rooms: fake, verify: jsonVerifier }),
    ],
  });
  owner = await s.setupOwner();
  const channels = (await api(owner).get("/channels")).body as { channels: { id: string; type: string }[] };
  lounge = channels.channels.find((c) => c.type === "voice")!.id;
  second = (await api(owner).post("/channels", { type: "voice", name: "Second" })).body.id as string;
  const roles = (await api(owner).get("/roles")).body as { id: string; name: string }[];
  const adminRole = roles.find((r) => r.name === "Admin")!.id;
  const modRole = roles.find((r) => r.name === "Moderator")!.id;
  admin = await s.register("adm");
  mod = await s.register("mod");
  mod2 = await s.register("mod2");
  ann = await s.register("ann");
  bo = await s.register("bo");
  await api(owner).put(`/members/${admin.id}/roles/${adminRole}`);
  await api(owner).put(`/members/${mod.id}/roles/${modRole}`);
  await api(owner).put(`/members/${mod2.id}/roles/${modRole}`);
});
afterEach(async () => {
  await s.close();
});

describe("hierarchy and permissions (11 §2.4)", () => {
  it("a plain member can do none of it", async () => {
    const a = api(ann.token);
    expect((await a.post(`/members/${bo.id}/kick`)).status).toBe(403);
    expect((await a.put(`/members/${bo.id}/ban`)).status).toBe(403);
    expect((await a.put(`/members/${bo.id}/timeout`, { durationSecs: 60 })).status).toBe(403);
    expect((await a.put(`/members/${bo.id}/voice`, { muted: true })).status).toBe(403);
    expect((await a.get("/audit-log")).status).toBe(403);
    expect((await a.get("/bans")).status).toBe(403);
  });

  it("nobody acts on an equal or higher role, on the owner or on themselves", async () => {
    expect((await api(mod.token).post(`/members/${mod2.id}/kick`)).status).toBe(403);
    expect((await api(mod.token).post(`/members/${admin.id}/kick`)).status).toBe(403);
    expect((await api(admin.token).put(`/members/${await ownerId()}/ban`)).status).toBe(403);
    expect((await api(owner).put(`/members/${await ownerId()}/timeout`, { durationSecs: 60 })).status).toBe(
      403,
    );
    expect((await api(mod.token).put(`/members/${mod.id}/timeout`, { durationSecs: 60 })).status).toBe(403);
    // Above is fine: a moderator times out a member, an admin bans a moderator, the owner kicks an admin.
    expect((await api(mod.token).put(`/members/${ann.id}/timeout`, { durationSecs: 60 })).status).toBe(204);
    expect((await api(admin.token).put(`/members/${mod2.id}/ban`, {})).status).toBe(200);
    expect((await api(owner).post(`/members/${admin.id}/kick`)).status).toBe(204);
  });

  it("a moderator can kick but not ban; the permission is the one the action names", async () => {
    expect((await api(mod.token).put(`/members/${ann.id}/ban`, {})).status).toBe(403);
    expect((await api(mod.token).post(`/members/${ann.id}/kick`)).status).toBe(204);
  });

  it("unknown members are 404", async () => {
    expect((await api(owner).post(`/members/nobody/kick`)).status).toBe(404);
  });

  async function ownerId(): Promise<string> {
    const m = (await api(owner).get("/members")).body.items as { userId: string; isOwner: boolean }[];
    return m.find((x) => x.isOwner)!.userId;
  }
});

describe("kick and ban (11 §2.6)", () => {
  it("kick ends sessions, closes sockets, removes from voice, and is audited", async () => {
    const sock = await identified(ann.token);
    await enterVoice(ann);
    await enterVoice(bo);
    const res = await api(mod.token).post(`/members/${ann.id}/kick`, { reason: "spam" });
    expect(res.status).toBe(204);
    expect((await sock.closed).code).toBe(4004);
    expect((await api(ann.token).get("/users/@me")).status).toBe(401);
    expect(fake.rooms.get(voiceRoomName(lounge))!.participants.has(ann.id)).toBe(false);
    expect((await inVoice()).map((p) => p.userId)).toEqual([bo.id]);
    // A kick is not a ban: logging in again works.
    expect((await s.login("ann", "correct horse battery staple")).status).toBe(200);

    const log = (await api(owner).get("/audit-log?action=member.kick")).body;
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({
      actorId: mod.id,
      action: "member.kick",
      targetId: ann.id,
      reason: "spam",
    });
  });

  it("ban blocks login (BANNED), removes messages in the purge window, and unban restores", async () => {
    const generalId = (
      (await api(owner).get("/channels")).body.channels as { id: string; type: string }[]
    ).find((c) => c.type === "text")!.id;
    const msg = await api(ann.token).post(`/channels/${generalId}/messages`, { content: "buy my stuff" });
    expect(msg.status).toBe(201);
    const ban = await api(admin.token).put(`/members/${ann.id}/ban`, { reason: "spam", purgeDays: 1 });
    expect(ban.status).toBe(200);
    expect(ban.body.purged).toBe(1);
    const history = await api(owner).get(`/channels/${generalId}/messages`);
    expect(JSON.stringify(history.body)).not.toContain("buy my stuff");

    const login = await s.login("ann", "correct horse battery staple");
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe("BANNED");
    expect(login.body.error.message).toContain("spam");
    // A wrong password must not reveal the ban.
    expect((await s.login("ann", "wrong wrong wrong wrong")).status).toBe(401);

    expect((await api(admin.token).get("/bans")).body).toMatchObject([{ userId: ann.id, reason: "spam" }]);
    expect((await api(admin.token).del(`/members/${ann.id}/ban`)).status).toBe(204);
    expect((await s.login("ann", "correct horse battery staple")).status).toBe(200);
    const actions = (await api(owner).get("/audit-log")).body.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(expect.arrayContaining(["member.ban", "member.unban"]));
  });

  it("a ban needs BAN_MEMBERS; unban of someone not banned is 404", async () => {
    expect((await api(admin.token).del(`/members/${bo.id}/ban`)).status).toBe(404);
    expect((await api(mod.token).del(`/members/${bo.id}/ban`)).status).toBe(403);
  });
});

describe("timeout (11 §2.6)", () => {
  it("removes posting and speaking at once, shows on the member, and clears early", async () => {
    const generalId = (
      (await api(owner).get("/channels")).body.channels as { id: string; type: string }[]
    ).find((c) => c.type === "text")!.id;
    await enterVoice(ann);
    expect(
      (await api(mod.token).put(`/members/${ann.id}/timeout`, { durationSecs: 3600, reason: "cool off" }))
        .status,
    ).toBe(204);
    const sent = await api(ann.token).post(`/channels/${generalId}/messages`, { content: "hello" });
    expect(sent.status).toBe(403);
    await expect
      .poll(() => fake.rooms.get(voiceRoomName(lounge))!.participants.get(ann.id)!.permission.sources, {
        timeout: 2000,
      })
      .toEqual([]);
    const members = (await api(owner).get("/members")).body.items as {
      userId: string;
      timeoutUntil?: string | null;
    }[];
    expect(members.find((m) => m.userId === ann.id)!.timeoutUntil).toBeTruthy();

    expect((await api(mod.token).put(`/members/${ann.id}/timeout`, { durationSecs: null })).status).toBe(204);
    expect((await api(ann.token).post(`/channels/${generalId}/messages`, { content: "back" })).status).toBe(
      201,
    );
    await expect
      .poll(() => fake.rooms.get(voiceRoomName(lounge))!.participants.get(ann.id)!.permission.sources, {
        timeout: 2000,
      })
      .toContain("microphone");
  });

  it("ends by itself when the time is up", async () => {
    const generalId = (
      (await api(owner).get("/channels")).body.channels as { id: string; type: string }[]
    ).find((c) => c.type === "text")!.id;
    await api(mod.token).put(`/members/${ann.id}/timeout`, { durationSecs: 60 });
    expect((await api(ann.token).post(`/channels/${generalId}/messages`, { content: "x" })).status).toBe(403);
    // A minute and a bit later, as far as the server's clock is concerned; the job (every 100 ms here) ends it.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      await s.running.ports.pubsub.kv.del(`rl:msg:${ann.id}:${generalId}`);
      await expect
        .poll(
          async () =>
            (await api(ann.token).post(`/channels/${generalId}/messages`, { content: "after" })).status,
          {
            timeout: 3000,
            interval: 150,
          },
        )
        .toBe(201);
      const members = (await api(owner).get("/members")).body.items as {
        userId: string;
        timeoutUntil?: string | null;
      }[];
      expect(members.find((m) => m.userId === ann.id)!.timeoutUntil ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server mute and deafen (11 §3)", () => {
  it("takes the microphone from a live session, persists across rejoining, and shows to the room", async () => {
    await enterVoice(ann);
    const res = await api(mod.token).put(`/members/${ann.id}/voice`, { muted: true });
    expect(res.body).toEqual({ muted: true, deafened: false });
    await expect
      .poll(() => fake.rooms.get(voiceRoomName(lounge))!.participants.get(ann.id)!.permission.sources, {
        timeout: 2000,
      })
      .not.toContain("microphone");
    const state = (await api(owner).get("/voice/state")).body.voice[lounge] as {
      userId: string;
      serverMuted: boolean;
    }[];
    expect(state.find((p) => p.userId === ann.id)!.serverMuted).toBe(true);

    // Leaving and joining again does not undo it.
    const join = await api(ann.token).post(`/voice/channels/${lounge}/join`, { e2ee: true });
    const claims = JSON.parse(Buffer.from(join.body.token.split(".")[1], "base64url").toString());
    expect(claims.video.canPublishSources).not.toContain(2);
    expect(join.body.publishDefaults.sources).not.toContain("microphone");

    await api(mod.token).put(`/members/${ann.id}/voice`, { muted: false });
    await expect
      .poll(() => fake.rooms.get(voiceRoomName(lounge))!.participants.get(ann.id)!.permission.sources, {
        timeout: 2000,
      })
      .toContain("microphone");
  });

  it("deafen stops subscribing and needs a change in the body", async () => {
    await enterVoice(ann);
    await api(mod.token).put(`/members/${ann.id}/voice`, { deafened: true });
    await expect
      .poll(() => fake.rooms.get(voiceRoomName(lounge))!.participants.get(ann.id)!.permission.canSubscribe, {
        timeout: 2000,
      })
      .toBe(false);
    expect((await api(mod.token).put(`/members/${ann.id}/voice`, {})).status).toBe(400);
  });

  it("a moderator cannot server-mute an equal", async () => {
    expect((await api(mod.token).put(`/members/${mod2.id}/voice`, { muted: true })).status).toBe(403);
  });
});

describe("move and disconnect (11 §3)", () => {
  it("tells the person where to go and refuses a destination they cannot join", async () => {
    const sock = await identified(ann.token);
    await enterVoice(ann);
    expect((await api(mod.token).post(`/members/${ann.id}/voice/move`, { channelId: second })).status).toBe(
      204,
    );
    const f = await sock.next((x) => x.t === "VOICE_SERVER_DISCONNECT");
    expect(f.d).toMatchObject({ channelId: lounge, reason: "moved_by_moderator", to: second });
    expect(fake.rooms.get(voiceRoomName(lounge))!.participants.has(ann.id)).toBe(false);

    // Not in voice any more.
    expect((await api(mod.token).post(`/members/${ann.id}/voice/move`, { channelId: second })).status).toBe(
      409,
    );
    expect((await api(mod.token).post(`/members/${ann.id}/voice/disconnect`)).status).toBe(409);
    // A text channel is not a destination.
    await enterVoice(bo);
    const text = ((await api(owner).get("/channels")).body.channels as { id: string; type: string }[]).find(
      (c) => c.type === "text",
    )!.id;
    expect((await api(mod.token).post(`/members/${bo.id}/voice/move`, { channelId: text })).status).toBe(404);
    // CONNECT denied on the destination.
    await api(owner).put(`/channels/${second}/overwrites/member/${bo.id}`, {
      allow: "0",
      deny: String(1 << 8),
    });
    expect((await api(mod.token).post(`/members/${bo.id}/voice/move`, { channelId: second })).status).toBe(
      409,
    );
  });

  it("disconnect sends a reason and keeps the account signed in", async () => {
    const sock = await identified(ann.token);
    await enterVoice(ann);
    expect(
      (await api(mod.token).post(`/members/${ann.id}/voice/disconnect`, { reason: "echo" })).status,
    ).toBe(204);
    expect((await sock.next((x) => x.t === "VOICE_SERVER_DISCONNECT")).d).toMatchObject({
      reason: "disconnected",
    });
    expect((await api(ann.token).get("/users/@me")).status).toBe(200);
    const log = (await api(owner).get("/audit-log?action=voice.")).body.items;
    expect(log[0]).toMatchObject({ action: "voice.disconnect", reason: "echo" });
  });
});

describe("audit log (06 §3.10)", () => {
  it("needs VIEW_AUDIT_LOG, pages newest first, and filters", async () => {
    for (const u of [ann, bo]) await api(mod.token).post(`/members/${u.id}/kick`);
    expect((await api(ann.token).get("/audit-log")).status).toBe(401); // her session was revoked by the kick
    const page1 = (await api(mod.token).get("/audit-log?limit=1")).body;
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].targetId).toBe(bo.id);
    expect(page1.next).toBeTruthy();
    const page2 = (await api(mod.token).get(`/audit-log?limit=1&before=${page1.next}`)).body;
    expect(page2.items[0].targetId).toBe(ann.id);
    expect((await api(mod.token).get(`/audit-log?targetId=${ann.id}`)).body.items).toHaveLength(1);
    expect((await api(mod.token).get(`/audit-log?actorId=${admin.id}`)).body.items).toHaveLength(0);
  });
});

describe("voice E2EE (10)", () => {
  const keyOf = (r: { e2ee: { key: string } | null }) => r.e2ee!.key;

  it("refuses a client that cannot encrypt, hands everyone in the room the same key, and withholds it from outsiders", async () => {
    const refused = await api(ann.token).post(`/voice/channels/${lounge}/join`, { e2ee: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({ reason: "e2ee_unsupported" });
    const a = await enterVoice(ann);
    const b = await enterVoice(bo);
    expect(a.e2ee).toMatchObject({ epoch: 0, keyIndex: 0 });
    expect(keyOf(a)).toBe(keyOf(b));
    expect(Buffer.from(keyOf(a), "base64")).toHaveLength(32);
    // Not in the room: no key. In the room: the same key again.
    expect((await api(mod.token).get(`/voice/channels/${lounge}/e2ee-key`)).status).toBe(404);
    expect((await api(ann.token).get(`/voice/channels/${lounge}/e2ee-key`)).body.key).toBe(keyOf(a));
  });

  it("the room metadata carries the epoch, so the key survives the app forgetting everything (T27)", async () => {
    const a = await enterVoice(ann);
    const meta = JSON.parse(fake.rooms.get(voiceRoomName(lounge))!.metadata) as {
      e2ee: { on: boolean; epoch: number };
    };
    expect(meta.e2ee).toEqual({ on: true, epoch: 0 });
    expect((await api(ann.token).get(`/voice/channels/${lounge}/e2ee-key`)).body.key).toBe(keyOf(a));
  });

  it("a kick rotates the key at once: the others get a new epoch and index, a late joiner gets it too", async () => {
    const sockBo = await identified(bo.token);
    const a = await enterVoice(ann);
    await enterVoice(bo);
    await api(mod.token).post(`/members/${ann.id}/kick`);
    const upd = await sockBo.next((f) => f.t === "E2EE_KEY_UPDATE");
    const d = upd.d as { channelId: string; epoch: number; keyIndex: number; key: string };
    expect(d).toMatchObject({ channelId: lounge, epoch: 1, keyIndex: 1 });
    expect(d.key).not.toBe(keyOf(a));
    const late = await enterVoice(mod);
    expect(late.e2ee).toMatchObject({ epoch: 1, key: d.key });
  });

  it("a voluntary leave rotates lazily: not within the quiet period, yes after it", async () => {
    await enterVoice(ann);
    await enterVoice(bo);
    await enterVoice(mod);
    const sockMod = await identified(mod.token);
    // First departure: nothing has been rotated yet, so the lazy rule rotates once.
    await webhook("participant_left", ann.id, `PA_${ann.id}`);
    await sockMod.next((f) => f.t === "E2EE_KEY_UPDATE");
    // A second one inside the five minutes does not.
    await webhook("participant_left", bo.id, `PA_${bo.id}`);
    await new Promise((r) => setTimeout(r, 150));
    expect(sockMod.frames.filter((f) => f.t === "E2EE_KEY_UPDATE")).toHaveLength(1);
  });

  it("a permission lost in the middle of a call rotates the key", async () => {
    const sockBo = await identified(bo.token);
    await enterVoice(ann);
    await enterVoice(bo);
    await api(owner).put(`/channels/${lounge}/overwrites/member/${ann.id}`, {
      allow: "0",
      deny: String(1 << 8),
    });
    const upd = await sockBo.next((f) => f.t === "E2EE_KEY_UPDATE");
    expect((upd.d as { epoch: number }).epoch).toBe(1);
  });

  it("required beats a server default that is off; off beats a default that is on", async () => {
    await api(owner).patch("/admin/voice/e2ee", { enabled: false });
    // Default off: a client without support joins an inherit channel in the clear.
    const plain = await api(ann.token).post(`/voice/channels/${lounge}/join`, { e2ee: false });
    expect(plain.status).toBe(200);
    expect(plain.body.e2ee ?? null).toBeNull();
    await api(owner).patch(`/channels/${second}`, { settings: { e2ee: "required" } });
    expect((await api(ann.token).post(`/voice/channels/${second}/join`, { e2ee: false })).status).toBe(409);
    expect(
      (await api(ann.token).post(`/voice/channels/${second}/join`, { e2ee: true })).body.e2ee,
    ).not.toBeNull();
    await api(owner).patch("/admin/voice/e2ee", { enabled: true });
    await api(owner).patch(`/channels/${second}`, { settings: { e2ee: "off" } });
    expect((await api(bo.token).post(`/voice/channels/${second}/join`, { e2ee: false })).status).toBe(200);
  });

  it("changing the mode of an occupied channel closes the room and tells everyone to rejoin", async () => {
    const sock = await identified(ann.token);
    await enterVoice(ann);
    await api(owner).patch(`/channels/${lounge}`, { settings: { e2ee: "off" } });
    const f = await sock.next((x) => x.t === "VOICE_SERVER_DISCONNECT");
    expect(f.d).toMatchObject({ channelId: lounge, reason: "e2ee_mode_changed" });
    expect(fake.rooms.has(voiceRoomName(lounge))).toBe(false);
    // The next join builds a fresh, unencrypted room.
    const again = await api(ann.token).post(`/voice/channels/${lounge}/join`, { e2ee: true });
    expect(again.body.e2ee ?? null).toBeNull();
  });

  it("only the owner changes the server default", async () => {
    expect((await api(admin.token).patch("/admin/voice/e2ee", { enabled: false })).status).toBe(403);
    expect((await api(owner).get("/admin/voice/e2ee")).body).toEqual({ enabled: true });
  });
});
