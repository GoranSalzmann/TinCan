// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { Op, PERM, permissionsToString, voiceRoomName, type VoiceSource } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer, type TestSocket } from "../../testing/harness.js";
import { ALL_MODULES } from "../index.js";
import type { VoiceApi } from "./api.js";
import { FakeLiveKit, jsonVerifier } from "./fake-livekit.js";
import { createVoiceModule } from "./index.js";
import type { LkWebhookEvent } from "./livekit.js";

const KEY = "devkey";
const SECRET = "voice-test-secret-".padEnd(40, "x");
const ALL_SOURCES: VoiceSource[] = ["microphone", "camera", "screen_share", "screen_share_audio"];

let s: TestServer;
let fake: FakeLiveKit;
let owner: string;
let lounge: string;

async function start(opts: { real?: boolean; voice?: Record<string, unknown> } = {}): Promise<void> {
  fake = new FakeLiveKit();
  const voice = opts.real
    ? createVoiceModule({ rooms: fake })
    : createVoiceModule({ rooms: fake, verify: jsonVerifier });
  s = await startTestServer({
    config: {
      livekit: { url: "ws://localhost/livekit", apiKey: KEY, apiSecret: SECRET },
      modules: {
        accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
        voice: { reconcileIntervalMs: 3_600_000, ...opts.voice },
      },
    },
    modules: [...ALL_MODULES.filter((m) => m.id !== "voice"), voice],
  });
  owner = await s.setupOwner();
  const list = (await api(owner).get("/channels")).body as { channels: { id: string; type: string }[] };
  lounge = list.channels.find((c) => c.type === "voice")!.id;
}

beforeEach(() => start());
afterEach(async () => {
  await s.close();
});

const api = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
  put: (path: string, body?: unknown) => s.request("PUT", `/api/v1${path}`, { token, body }),
  patch: (path: string, body?: unknown) => s.request("PATCH", `/api/v1${path}`, { token, body }),
  del: (path: string) => s.request("DELETE", `/api/v1${path}`, { token }),
});

const voiceApi = () => s.running.apis.get<VoiceApi>("voice")!;
const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, any>;

const deny = (channelId: string, userId: string, ...bits: (keyof typeof PERM)[]) =>
  api(owner).put(`/channels/${channelId}/overwrites/member/${userId}`, {
    allow: "0",
    deny: permissionsToString(bits.reduce((a, b) => a | PERM[b], 0n)),
  });

let seq = 0;
function event(
  kind: string,
  room: string,
  userId: string,
  sid: string,
  extra: Partial<LkWebhookEvent> = {},
): LkWebhookEvent {
  return {
    id: `EV_${++seq}`,
    event: kind,
    createdAt: Math.floor(Date.now() / 1000),
    room: { name: room, sid: "RM_x" },
    participant: { identity: userId, sid },
    track: null,
    ...extra,
  };
}
const post = (e: LkWebhookEvent, auth = "ok") =>
  fetch(`${s.url}/api/v1/internal/livekit/webhook`, {
    method: "POST",
    headers: { "content-type": "application/webhook+json", authorization: auth },
    body: JSON.stringify(e),
  });
const joined = (userId: string, sid: string, channel = lounge) =>
  post(event("participant_joined", voiceRoomName(channel), userId, sid));
const left = (userId: string, sid: string, channel = lounge) =>
  post(event("participant_left", voiceRoomName(channel), userId, sid));
const state = async (token = owner) =>
  (await api(token).get("/voice/state")).body.voice as Record<
    string,
    { userId: string; sources: string[] }[]
  >;

async function identified(token: string): Promise<TestSocket> {
  const sock = s.connect();
  await sock.next();
  sock.send({ op: Op.IDENTIFY, d: { token, client: { name: "t", version: "1", platform: "node" } } });
  await sock.next((f) => f.t === "READY");
  return sock;
}

describe("token grants follow permissions (08 §8)", () => {
  const cases: { name: string; deny: (keyof typeof PERM)[]; sources: VoiceSource[]; publish: boolean }[] = [
    { name: "default member", deny: [], sources: ALL_SOURCES, publish: true },
    {
      name: "no SPEAK",
      deny: ["SPEAK"],
      sources: ["camera", "screen_share", "screen_share_audio"],
      publish: true,
    },
    {
      name: "no VIDEO",
      deny: ["VIDEO"],
      sources: ["microphone", "screen_share", "screen_share_audio"],
      publish: true,
    },
    { name: "no SCREEN_SHARE", deny: ["SCREEN_SHARE"], sources: ["microphone", "camera"], publish: true },
    { name: "listener only", deny: ["SPEAK", "VIDEO", "SCREEN_SHARE"], sources: [], publish: false },
  ];
  for (const c of cases) {
    it(`${c.name}`, async () => {
      const ann = await s.register("ann");
      if (c.deny.length) await deny(lounge, ann.id, ...c.deny);
      const res = await api(ann.token).post(`/voice/channels/${lounge}/join`);
      expect(res.status).toBe(200);
      const g = claims(res.body.token).video;
      expect(g.roomJoin).toBe(true);
      expect(g.room).toBe(voiceRoomName(lounge));
      expect(g.canSubscribe).toBe(true);
      expect(g.canPublish).toBe(c.publish);
      expect([...(g.canPublishSources ?? [])].sort()).toEqual([...c.sources].sort());
      // Never in a client token: data channels, room admin, room creation, hidden or recorder flags.
      expect(g.canPublishData).toBe(false);
      for (const k of [
        "roomAdmin",
        "roomCreate",
        "roomList",
        "roomRecord",
        "hidden",
        "recorder",
        "ingressAdmin",
      ]) {
        expect(g[k]).toBeFalsy();
      }
      expect(claims(res.body.token).sub).toBe(ann.id);
      expect(res.body.publishDefaults.sources.sort()).toEqual([...c.sources].sort());
    });
  }

  it("refuses without CONNECT (403) and answers 404 when the channel is hidden", async () => {
    const ann = await s.register("ann");
    await deny(lounge, ann.id, "CONNECT");
    const noConnect = await api(ann.token).post(`/voice/channels/${lounge}/join`);
    expect(noConnect.status).toBe(403);
    expect(noConnect.body.error.code).toBe("PERMISSION_DENIED");

    const bo = await s.register("bo");
    await deny(lounge, bo.id, "VIEW_CHANNEL");
    const hidden = await api(bo.token).post(`/voice/channels/${lounge}/join`);
    const missing = await api(bo.token).post(`/voice/channels/nope/join`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe(missing.body.error.code);
    expect(hidden.body.error.message).toBe(missing.body.error.message);
  });

  it("is not available for text channels, archived channels or without a login", async () => {
    const list = (await api(owner).get("/channels")).body as { channels: { id: string; type: string }[] };
    const text = list.channels.find((c) => c.type === "text")!.id;
    expect((await api(owner).post(`/voice/channels/${text}/join`)).status).toBe(404);
    expect((await s.request("POST", `/api/v1/voice/channels/${lounge}/join`)).status).toBe(401);
    const extra = (await api(owner).post("/channels", { type: "voice", name: "Old" })).body.id as string;
    await api(owner).patch(`/channels/${extra}`, { archived: true });
    expect((await api(owner).post(`/voice/channels/${extra}/join`)).status).toBe(404);
  });

  it("honours per-channel switches and the user limit", async () => {
    const ann = await s.register("ann");
    const bo = await s.register("bo");
    await api(owner).patch(`/channels/${lounge}`, {
      settings: { videoAllowed: false, screenshareAllowed: false, userLimit: 1, bitrateKbps: 24 },
    });
    const res = await api(ann.token).post(`/voice/channels/${lounge}/join`);
    expect(res.body.publishDefaults.sources).toEqual(["microphone"]);
    expect(res.body.publishDefaults.audioBitrateKbps).toBe(24);
    expect(fake.rooms.get(voiceRoomName(lounge))!.opts.maxParticipants).toBe(1);

    await joined(ann.id, "PA_ann");
    const full = await api(bo.token).post(`/voice/channels/${lounge}/join`);
    expect(full.status).toBe(409);
    expect(full.body.error.details).toMatchObject({ reason: "channel_full", limit: 1 });
    // The person already inside can still get a fresh token (rejoin, second device).
    expect((await api(ann.token).post(`/voice/channels/${lounge}/join`)).status).toBe(200);
  });

  it("creates the room explicitly before minting, and says UNAVAILABLE when LiveKit is down", async () => {
    const ann = await s.register("ann");
    await api(ann.token).post(`/voice/channels/${lounge}/join`);
    expect(fake.calls.filter((c) => c !== "listRooms")[0]).toBe("createRoom");
    expect(fake.rooms.get(voiceRoomName(lounge))!.opts).toMatchObject({
      emptyTimeoutSecs: 60,
      departureTimeoutSecs: 20,
    });
    fake.failing.add("createRoom");
    const down = await api(ann.token).post(`/voice/channels/${lounge}/join`);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("UNAVAILABLE");
    expect((await api(ann.token).get("/channels")).status).toBe(200); // text is unaffected
  });

  it("limits joins per user", async () => {
    await s.close();
    await start({ voice: { joinRate: { max: 2, windowSecs: 60 } } });
    const ann = await s.register("ann");
    const join = () => api(ann.token).post(`/voice/channels/${lounge}/join`);
    expect((await join()).status).toBe(200);
    expect((await join()).status).toBe(200);
    expect((await join()).status).toBe(429);
  });
});

describe("connection test", () => {
  it("hands out a listen-only token for a private room that is not presence", async () => {
    const ann = await s.register("ann");
    const res = await api(ann.token).post("/voice/diagnostics");
    expect(res.status).toBe(200);
    const c = claims(res.body.token);
    expect(c.video.room).toBe(`diag_${ann.id}`);
    expect(c.video.canPublish).toBe(false);
    expect(c.video.canPublishData).toBe(false);
    expect(c.exp - c.nbf).toBeLessThanOrEqual(61);
    await post(event("participant_joined", res.body.roomName, ann.id, "PA_d"));
    expect(await state(ann.token)).toEqual({});
    expect((await s.request("POST", "/api/v1/voice/diagnostics")).status).toBe(401);
  });
});

describe("webhook endpoint", () => {
  it("rejects a missing or wrong signature and counts it", async () => {
    const ann = await s.register("ann");
    const bad = await post(event("participant_joined", voiceRoomName(lounge), ann.id, "PA_1"), "nope");
    expect(bad.status).toBe(401);
    expect(await state()).toEqual({});
    expect(voiceApi().stats().webhooks.rejected).toBe(1);
  });

  it("accepts LiveKit's real signing scheme (JWT with a body hash)", async () => {
    await s.close();
    await start({ real: true });
    const ann = await s.register("ann");
    const body = JSON.stringify({
      event: "participant_joined",
      id: "EV_real",
      createdAt: String(Math.floor(Date.now() / 1000)),
      room: { name: voiceRoomName(lounge), sid: "RM_1" },
      participant: { identity: ann.id, sid: "PA_1" },
    });
    const sign = async (b: string, secret = SECRET) => {
      const t = new AccessToken(KEY, secret);
      (t as unknown as { sha256: string }).sha256 = createHash("sha256").update(b).digest("base64");
      return t.toJwt();
    };
    const url = `${s.url}/api/v1/internal/livekit/webhook`;
    const headers = (auth: string) => ({ "content-type": "application/webhook+json", authorization: auth });
    expect(
      (await fetch(url, { method: "POST", headers: headers(await sign(body, "x".repeat(40))), body })).status,
    ).toBe(401);
    expect((await fetch(url, { method: "POST", headers: headers(await sign("{}")), body })).status).toBe(401); // hash of another body
    expect((await fetch(url, { method: "POST", headers: headers(await sign(body)), body })).status).toBe(200);
    expect(Object.keys(await state(ann.token))).toEqual([lounge]);
  });
});

describe("presence from webhooks and the races between them (D1)", () => {
  it("tracks join, published sources and leave, and tells connected clients", async () => {
    const ann = await s.register("ann");
    const watcher = await identified(owner);
    await joined(ann.id, "PA_1");
    const update = await watcher.next((f) => f.t === "VOICE_STATE_UPDATE");
    expect(update.d).toMatchObject({ channelId: lounge, userId: ann.id, joined: true });
    await post(
      event("track_published", voiceRoomName(lounge), ann.id, "PA_1", {
        track: { sid: "TR_1", source: "microphone", muted: false },
      }),
    );
    await post(
      event("track_published", voiceRoomName(lounge), ann.id, "PA_1", {
        track: { sid: "TR_2", source: "screen_share", muted: false },
      }),
    );
    expect((await state())[lounge]![0]!.sources.sort()).toEqual(["microphone", "screen_share"]);
    await post(
      event("track_unpublished", voiceRoomName(lounge), ann.id, "PA_1", {
        track: { sid: "TR_2", source: "screen_share", muted: false },
      }),
    );
    expect((await state())[lounge]![0]!.sources).toEqual(["microphone"]);
    await left(ann.id, "PA_1");
    expect(await state()).toEqual({});
    const gone = await watcher.next(
      (f) => f.t === "VOICE_STATE_UPDATE" && (f.d as { joined: boolean }).joined === false,
    );
    expect(gone.d).toMatchObject({ userId: ann.id });
    watcher.close();
  });

  it("applies a duplicate delivery once", async () => {
    const ann = await s.register("ann");
    const e = event("participant_joined", voiceRoomName(lounge), ann.id, "PA_1");
    await post(e);
    await post(e);
    expect(voiceApi().stats().webhooks.duplicates).toBe(1);
    expect(voiceApi().participants(lounge)).toHaveLength(1);
  });

  it("ignores the late 'left' of an old session after the person rejoined", async () => {
    const ann = await s.register("ann");
    await joined(ann.id, "PA_old");
    await joined(ann.id, "PA_new"); // rejoin: the new session replaces the old one
    await left(ann.id, "PA_old"); // webhook of the old session arrives last
    expect(
      voiceApi()
        .participants(lounge)
        .map((p) => p.userId),
    ).toEqual([ann.id]);
    await left(ann.id, "PA_new");
    expect(voiceApi().participants(lounge)).toHaveLength(0);
  });

  it("does not resurrect a session whose 'left' overtook its 'joined'", async () => {
    const ann = await s.register("ann");
    await left(ann.id, "PA_1");
    await joined(ann.id, "PA_1");
    expect(voiceApi().participants(lounge)).toHaveLength(0);
  });

  it("fetches the room when a track event overtakes the join", async () => {
    const ann = await s.register("ann");
    fake.connect(voiceRoomName(lounge), ann.id, { sid: "PA_1", sources: ["microphone"] });
    await post(
      event("track_published", voiceRoomName(lounge), ann.id, "PA_1", {
        track: { sid: "TR", source: "microphone", muted: false },
      }),
    );
    await expect.poll(async () => (await state())[lounge]?.[0]?.sources).toEqual(["microphone"]);
  });

  it("drops a stale unpublish that lost the race with a newer publish", async () => {
    const ann = await s.register("ann");
    const t = Math.floor(Date.now() / 1000);
    await post(event("participant_joined", voiceRoomName(lounge), ann.id, "PA_1", { createdAt: t }));
    await post(
      event("track_published", voiceRoomName(lounge), ann.id, "PA_1", {
        createdAt: t + 5,
        track: { sid: "T", source: "camera", muted: false },
      }),
    );
    await post(
      event("track_unpublished", voiceRoomName(lounge), ann.id, "PA_1", {
        createdAt: t + 2,
        track: { sid: "T", source: "camera", muted: false },
      }),
    );
    expect((await state())[lounge]![0]!.sources).toEqual(["camera"]);
  });

  it("clears a room on room_finished and ignores rooms that are not voice channels", async () => {
    const ann = await s.register("ann");
    await joined(ann.id, "PA_1");
    await post(event("participant_joined", "something_else", ann.id, "PA_2"));
    await post(event("room_finished", voiceRoomName(lounge), ann.id, "PA_1", { participant: null }));
    expect(await state()).toEqual({});
  });

  it("shows voice presence only to people who can see the channel", async () => {
    const ann = await s.register("ann");
    const bo = await s.register("bo");
    await deny(lounge, bo.id, "VIEW_CHANNEL");
    await joined(ann.id, "PA_1");
    expect(Object.keys(await state(bo.token))).toEqual([]);
    expect(Object.keys(await state(owner))).toEqual([lounge]);
  });

  it("includes the current state in READY and applies self mute/deafen from the gateway", async () => {
    const ann = await s.register("ann");
    await joined(ann.id, "PA_1");
    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: ann.token, client: { name: "t", version: "1", platform: "node" } },
    });
    const ready = (await sock.next((f) => f.t === "READY")).d as { voice: Record<string, unknown[]> };
    expect(ready.voice[lounge]).toHaveLength(1);
    sock.send({ op: Op.COMMAND, d: { cmd: "voice.state", args: { muted: true, deafened: true }, id: "1" } });
    const upd = await sock.next((f) => f.t === "VOICE_STATE_UPDATE");
    expect((upd.d as { participant: { muted: boolean; deafened: boolean } }).participant).toMatchObject({
      muted: true,
      deafened: true,
    });
    sock.close();
  });
});

describe("permission enforcement: fast path and reconciler (T25)", () => {
  async function inRoom(name: string, sources: VoiceSource[] = ["microphone"]) {
    const u = await s.register(name);
    fake.connect(voiceRoomName(lounge), u.id, { sid: `PA_${name}`, sources });
    await joined(u.id, `PA_${name}`);
    return u;
  }

  it("downgrades a connected person within seconds when SPEAK is taken away", async () => {
    const ann = await inRoom("ann");
    const t0 = Date.now();
    await deny(lounge, ann.id, "SPEAK");
    await expect
      .poll(() => fake.rooms.get(voiceRoomName(lounge))!.participants.get(ann.id)!.permission.sources, {
        timeout: 2000,
      })
      .not.toContain("microphone");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("removes a connected person at once when CONNECT is taken away and tells them why", async () => {
    const ann = await inRoom("ann");
    const sock = await identified(ann.token);
    await deny(lounge, ann.id, "CONNECT");
    const msg = await sock.next((f) => f.t === "VOICE_SERVER_DISCONNECT");
    expect(msg.d).toEqual({ channelId: lounge, reason: "permission_lost" });
    expect(fake.rooms.get(voiceRoomName(lounge))!.participants.has(ann.id)).toBe(false);
    expect(voiceApi().participants(lounge)).toHaveLength(0);
    sock.close();
  });

  it("the reconciler repairs what the fast path could not do while LiveKit was unreachable", async () => {
    const ann = await inRoom("ann");
    fake.failing.add("*");
    await deny(lounge, ann.id, "CONNECT");
    await new Promise((r) => setTimeout(r, 300));
    // The fast path gave up quietly, so the person is still in LiveKit …
    fake.failing.clear();
    expect(fake.rooms.get(voiceRoomName(lounge))!.participants.has(ann.id)).toBe(true);
    // … and the next pass removes them.
    await voiceApi().reconcileNow();
    expect(fake.rooms.get(voiceRoomName(lounge))!.participants.has(ann.id)).toBe(false);
    expect(voiceApi().stats().reconcile.repairs.participant_removed).toBe(1);
  });

  it("corrects a grant that differs from the database and counts the repair", async () => {
    const ann = await inRoom("ann");
    await deny(lounge, ann.id, "VIDEO");
    await expect.poll(() => fake.calls.includes("updatePermission")).toBe(true);
    // Drift: someone widened the grant behind our back.
    fake.rooms.get(voiceRoomName(lounge))!.participants.get(ann.id)!.permission.sources = ALL_SOURCES;
    await voiceApi().reconcileNow();
    expect(fake.rooms.get(voiceRoomName(lounge))!.participants.get(ann.id)!.permission.sources).not.toContain(
      "camera",
    );
    expect(voiceApi().stats().reconcile.repairs.permission_updated).toBe(1);
  });

  it("adds people whose join webhook was lost, and drops ghosts after two passes", async () => {
    const ann = await s.register("ann");
    fake.connect(voiceRoomName(lounge), ann.id, { sid: "PA_1", sources: ["microphone"] });
    await voiceApi().reconcileNow();
    expect(
      voiceApi()
        .participants(lounge)
        .map((p) => p.userId),
    ).toEqual([ann.id]);
    expect(voiceApi().stats().reconcile.repairs.presence_added).toBe(1);

    const bo = await s.register("bo");
    fake.connect(voiceRoomName(lounge), bo.id, { sid: "PA_2" });
    await joined(bo.id, "PA_2");
    fake.vanish(voiceRoomName(lounge), bo.id); // LiveKit lost them; the 'left' webhook never came
    await voiceApi().reconcileNow();
    expect(voiceApi().participants(lounge)).toHaveLength(2); // one miss is not enough
    await voiceApi().reconcileNow();
    expect(
      voiceApi()
        .participants(lounge)
        .map((p) => p.userId),
    ).toEqual([ann.id]);
    expect(voiceApi().stats().reconcile.repairs.presence_removed).toBe(1);
  });

  it("drops presence immediately when the whole room is gone", async () => {
    const ann = await inRoom("ann");
    fake.rooms.delete(voiceRoomName(lounge));
    await voiceApi().reconcileNow();
    expect(voiceApi().participants(lounge)).toHaveLength(0);
    expect(ann.id).toBeTruthy();
  });

  it("removes a disabled account", async () => {
    const ann = await inRoom("ann");
    await (s.running.ports.db.query as any)
      .updateTable("user")
      .set({ disabled_at: Date.now() })
      .where("id", "=", ann.id)
      .execute();
    await voiceApi().reconcileNow();
    expect(fake.rooms.get(voiceRoomName(lounge))!.participants.has(ann.id)).toBe(false);
  });

  it("keeps one session per person across rooms and deletes rooms of deleted channels", async () => {
    const ann = await s.register("ann");
    const other = (await api(owner).post("/channels", { type: "voice", name: "Games" })).body.id as string;
    fake.connect(voiceRoomName(lounge), ann.id, { joinedAtMs: 1000 });
    fake.connect(voiceRoomName(other), ann.id, { joinedAtMs: 2000 });
    await voiceApi().reconcileNow();
    expect(fake.rooms.get(voiceRoomName(lounge))!.participants.has(ann.id)).toBe(false);
    expect(fake.rooms.get(voiceRoomName(other))!.participants.has(ann.id)).toBe(true);
    expect(voiceApi().stats().reconcile.repairs.duplicate_session).toBe(1);

    await api(owner).del(`/channels/${other}`);
    await expect.poll(() => fake.rooms.has(voiceRoomName(other))).toBe(false);
    expect(voiceApi().participants(other)).toHaveLength(0);
  });

  it("survives LiveKit being down: presence stays, the pass is recorded as unreachable", async () => {
    await inRoom("ann");
    fake.failing.add("listRooms");
    await voiceApi().reconcileNow();
    const r = voiceApi().stats().reconcile;
    expect(r.livekitReachable).toBe(false);
    expect(r.failures).toBe(1);
    expect(voiceApi().participants(lounge)).toHaveLength(1);
    fake.failing.clear();
    await voiceApi().reconcileNow();
    expect(voiceApi().stats().reconcile.livekitReachable).toBe(true);
  });

  it("joining another channel takes the person out of the first one", async () => {
    const ann = await inRoom("ann");
    const other = (await api(owner).post("/channels", { type: "voice", name: "Games" })).body.id as string;
    const res = await api(ann.token).post(`/voice/channels/${other}/join`);
    expect(res.status).toBe(200);
    expect(fake.rooms.get(voiceRoomName(lounge))!.participants.has(ann.id)).toBe(false);
    expect(voiceApi().participants(lounge)).toHaveLength(0);
  });

  it("explicit leave clears presence now; status is for people who manage the instance", async () => {
    const ann = await inRoom("ann");
    expect((await api(ann.token).post("/voice/leave")).status).toBe(204);
    expect(voiceApi().participants(lounge)).toHaveLength(0);
    expect((await api(ann.token).get("/voice/status")).status).toBe(403);
    const status = await api(owner).get("/voice/status");
    expect(status.status).toBe(200);
    expect(status.body.reconcile.repairs).toBeTypeOf("object");
  });
});

describe("camera and screen share (M4, 08 §5.2, §8)", () => {
  const room = () => fake.rooms.get(voiceRoomName(lounge))!;
  const grantOf = (id: string) => room().participants.get(id)!.permission;
  async function inRoom(name: string, sources: VoiceSource[] = ["microphone", "camera"]) {
    const u = await s.register(name);
    fake.connect(voiceRoomName(lounge), u.id, { sid: `PA_${name}`, sources });
    await joined(u.id, `PA_${name}`);
    return u;
  }

  it("hands out video caps: server default, a lower channel cap, never a higher one", async () => {
    const ann = await s.register("ann");
    const join = async () =>
      (await api(ann.token).post(`/voice/channels/${lounge}/join`)).body.publishDefaults.video;
    expect(await join()).toEqual({ cameraMaxKbps: 1700, screenshareMaxKbps: 6000 });
    await api(owner).patch(`/channels/${lounge}`, { settings: { maxScreenshareKbps: 2500 } });
    expect(await join()).toEqual({ cameraMaxKbps: 1700, screenshareMaxKbps: 2500 });
    await api(owner).patch(`/channels/${lounge}`, { settings: { maxScreenshareKbps: 20_000 } });
    expect((await join()).screenshareMaxKbps).toBe(6000);
    const bad = await api(owner).patch(`/channels/${lounge}`, { settings: { maxScreenshareKbps: 10 } });
    expect(bad.status).toBe(400);
    // A null clears the channel's own cap, so the server's applies again.
    await api(owner).patch(`/channels/${lounge}`, { settings: { maxScreenshareKbps: 2500 } });
    expect((await join()).screenshareMaxKbps).toBe(2500);
    const cleared = await api(owner).patch(`/channels/${lounge}`, { settings: { maxScreenshareKbps: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.settings.maxScreenshareKbps).toBeUndefined();
    expect((await join()).screenshareMaxKbps).toBe(6000);
  });

  it("lets the owner change the server-wide video caps at runtime", async () => {
    const ann = await s.register("ann");
    const join = async () =>
      (await api(ann.token).post(`/voice/channels/${lounge}/join`)).body.publishDefaults.video;
    expect((await api(ann.token).get("/admin/voice")).status).toBe(403);
    expect((await api(ann.token).patch("/admin/voice", { screenshareMaxKbps: 2000 })).status).toBe(403);
    expect((await api(owner).get("/admin/voice")).body).toEqual({
      cameraMaxKbps: 1700,
      screenshareMaxKbps: 6000,
    });
    const r = await api(owner).patch("/admin/voice", { screenshareMaxKbps: 2000, cameraMaxKbps: 900 });
    expect(r.status).toBe(200);
    expect(await join()).toEqual({ cameraMaxKbps: 900, screenshareMaxKbps: 2000 });
    expect((await api(owner).patch("/admin/voice", { screenshareMaxKbps: 100 })).status).toBe(400);
    expect((await api(owner).patch("/admin/voice", {})).status).toBe(400);
  });

  it("the server-wide caps come from the module config", async () => {
    await s.close();
    await start({ voice: { camera: { maxBitrateKbps: 900 }, screenshare: { maxBitrateKbps: 1500 } } });
    const ann = await s.register("ann");
    const res = await api(ann.token).post(`/voice/channels/${lounge}/join`);
    expect(res.body.publishDefaults.video).toEqual({ cameraMaxKbps: 900, screenshareMaxKbps: 1500 });
  });

  it("each bit controls its own sources: VIDEO the camera, SCREEN_SHARE the screen and its audio", async () => {
    const ann = await s.register("ann");
    await deny(lounge, ann.id, "VIDEO");
    const g1 = claims((await api(ann.token).post(`/voice/channels/${lounge}/join`)).body.token).video;
    expect(g1.canPublishSources).not.toContain(1 /* camera */);
    const bo = await s.register("bo");
    await deny(lounge, bo.id, "SCREEN_SHARE");
    const res = await api(bo.token).post(`/voice/channels/${lounge}/join`);
    expect(res.body.publishDefaults.sources).toEqual(["microphone", "camera"]);
  });

  it("takes the camera away within seconds when VIDEO is revoked mid-call, and leaves the rest", async () => {
    const ann = await inRoom("ann", ["microphone", "camera", "screen_share"]);
    await deny(lounge, ann.id, "VIDEO");
    await expect.poll(() => grantOf(ann.id).sources, { timeout: 2000 }).not.toContain("camera");
    expect(grantOf(ann.id)).toMatchObject({ canPublish: true, canSubscribe: true });
    expect(grantOf(ann.id).sources.sort()).toEqual(["microphone", "screen_share", "screen_share_audio"]);
  });

  it("takes screen share (video and audio) away when the channel switch is turned off mid-call", async () => {
    const ann = await inRoom("ann");
    await api(owner).patch(`/channels/${lounge}`, { settings: { screenshareAllowed: false } });
    await expect.poll(() => grantOf(ann.id).sources, { timeout: 2000 }).toEqual(["microphone", "camera"]);
    await api(owner).patch(`/channels/${lounge}`, { settings: { videoAllowed: false } });
    await expect.poll(() => grantOf(ann.id).sources, { timeout: 2000 }).toEqual(["microphone"]);
    // And back on: the grant widens again, so the client can publish after the switch returns.
    await api(owner).patch(`/channels/${lounge}`, {
      settings: { videoAllowed: true, screenshareAllowed: true },
    });
    await expect.poll(() => grantOf(ann.id).sources.length, { timeout: 2000 }).toBe(4);
  });

  it("the reconciler revokes camera and screen share when the fast path failed (≤ 30 s, T25)", async () => {
    const ann = await inRoom("ann", ["microphone", "camera", "screen_share"]);
    fake.failing.add("updatePermission");
    await deny(lounge, ann.id, "VIDEO", "SCREEN_SHARE");
    await new Promise((r) => setTimeout(r, 300));
    fake.failing.clear();
    expect(grantOf(ann.id).sources).toContain("camera"); // the fast path gave up quietly
    await voiceApi().reconcileNow();
    expect(grantOf(ann.id).sources).toEqual(["microphone"]);
    expect(voiceApi().stats().reconcile.repairs.permission_updated).toBe(1);
    // A second pass finds nothing left to repair.
    await voiceApi().reconcileNow();
    expect(voiceApi().stats().reconcile.repairs.permission_updated).toBe(1);
  });

  it("shows who is live with camera or screen to people who can see the channel, from track webhooks", async () => {
    const ann = await s.register("ann");
    await joined(ann.id, "PA_1");
    const bo = await s.register("bo");
    await deny(lounge, bo.id, "VIEW_CHANNEL");
    for (const [sid, source] of [
      ["TR_1", "camera"],
      ["TR_2", "screen_share"],
      ["TR_3", "screen_share_audio"],
    ] as const) {
      await post(
        event("track_published", voiceRoomName(lounge), ann.id, "PA_1", {
          track: { sid, source, muted: false },
        }),
      );
    }
    expect((await state())[lounge]![0]!.sources.sort()).toEqual([
      "camera",
      "screen_share",
      "screen_share_audio",
    ]);
    expect(await state(bo.token)).toEqual({});
    await post(
      event("track_unpublished", voiceRoomName(lounge), ann.id, "PA_1", {
        track: { sid: "TR_2", source: "screen_share", muted: false },
      }),
    );
    await post(
      event("track_unpublished", voiceRoomName(lounge), ann.id, "PA_1", {
        track: { sid: "TR_3", source: "screen_share_audio", muted: false },
      }),
    );
    expect((await state())[lounge]![0]!.sources).toEqual(["camera"]);
  });
});

describe("module switch", () => {
  it("is off without a livekit section, and the capability appears when on", async () => {
    const caps = (await s.request("GET", "/api/v1/capabilities", { token: owner })).body;
    expect(caps.features.voice).toMatchObject({ defaultUserLimit: 25 });
    await s.close();
    s = await startTestServer({
      modules: [
        ...ALL_MODULES.filter((m) => m.id !== "voice"),
        createVoiceModule({ rooms: new FakeLiveKit() }),
      ],
    });
    owner = await s.setupOwner();
    const off = await s.request("GET", "/api/v1/capabilities", { token: owner });
    expect(off.body.features.voice).toBeUndefined();
    expect((await api(owner).post(`/voice/channels/x/join`)).status).toBe(404);
  });
});
