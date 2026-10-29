// SPDX-License-Identifier: AGPL-3.0-or-later
import { Op } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER, startTestServer, type TestServer } from "../../testing/harness.js";

let s: TestServer;
let owner: string;

const argon2 = { memoryKiB: 1024, timeCost: 1, parallelism: 1 };
const call = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
  put: (path: string, body?: unknown) => s.request("PUT", `/api/v1${path}`, { token, body }),
  patch: (path: string, body?: unknown) => s.request("PATCH", `/api/v1${path}`, { token, body }),
  del: (path: string) => s.request("DELETE", `/api/v1${path}`, { token }),
});
const anon = (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { body });
const reg = async (username: string, inviteCode?: string) => {
  await s.running.ports.pubsub.kv.del("rl:register:ip:127.0.0.1");
  return anon("/auth/register", {
    username,
    displayName: username,
    password: OWNER.password,
    ...(inviteCode ? { inviteCode } : {}),
  });
};

beforeEach(async () => {
  s = await startTestServer({ config: { modules: { accounts: { signup: "invite-only", argon2 } } } });
  owner = await s.setupOwner();
});
afterEach(async () => {
  await s.close();
});

describe("registration", () => {
  it("needs an invite when signup is invite-only, and joins the member with @everyone only", async () => {
    const none = await reg("ann");
    expect(none.status).toBe(403);
    expect(none.body.error.details.reason).toBe("invite_required");

    const invite = (await call(owner).post("/invites", {})).body;
    expect(invite.code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const ok = await reg("ann", invite.code);
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.setCookie).toContain("tincan_session=");
    const members = (await call(owner).get("/members")).body.items;
    expect(members.map((m: any) => m.username)).toEqual(["mika", "ann"]);
    expect((await call(ok.body.token).get("/channels")).body.channels).toHaveLength(2);
    expect((await call(owner).get("/invites")).body[0].uses).toBe(1);
  });

  it("grants the invite's default role atomically with the account", async () => {
    const mod = ((await call(owner).get("/roles")).body as any[]).find((r) => r.name === "Moderator");
    const invite = (await call(owner).post("/invites", { defaultRoleId: mod.id })).body;
    const joined = await reg("ann", invite.code);
    const member = (await call(owner).get(`/members/${joined.body.user.id}`)).body;
    expect(member.roleIds).toEqual([mod.id]);
  });

  it("refuses a default role the inviter could not assign", async () => {
    const mod = ((await call(owner).get("/roles")).body as any[]).find((r) => r.name === "Moderator");
    const ann = await (async () => {
      const code = (await call(owner).post("/invites", {})).body.code;
      return (await reg("ann", code)).body;
    })();
    // @everyone can create invites but cannot hand out roles.
    expect((await call(ann.token).post("/invites", {})).status).toBe(201);
    const withRole = await call(ann.token).post("/invites", { defaultRoleId: mod.id });
    expect(withRole.status).toBe(403);
  });

  it("holds maxUses under concurrent registrations", async () => {
    const invite = (await call(owner).post("/invites", { maxUses: 2 })).body;
    const results = await Promise.all(["a1", "a2", "a3", "a4", "a5"].map((n) => reg(n, invite.code)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(2);
    expect(
      results.filter((r) => r.status !== 200).every((r) => r.body.error.code === "INVITE_EXHAUSTED"),
    ).toBe(true);
    expect(((await call(owner).get("/members")).body.items as unknown[]).length).toBe(3);
    // The failed attempts left no half-created accounts behind.
    expect((await s.login("a5", OWNER.password, { keepLimits: true })).status).toBe(401);
  });

  it("answers expired, revoked and unknown invites differently from success, and keeps the username free", async () => {
    const short = (await call(owner).post("/invites", { expiresInSecs: 60 })).body;
    const db = s.running.ports.db;
    await db.query
      .updateTable("invite" as never)
      .set({ expires_at: Date.now() - 1000 } as never)
      .where("id" as never, "=", short.id as never)
      .execute();
    const expired = await reg("ann", short.code);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe("INVITE_EXPIRED");

    const revoked = (await call(owner).post("/invites", {})).body;
    expect((await call(owner).del(`/invites/${revoked.id}`)).status).toBe(204);
    expect((await reg("ann", revoked.code)).status).toBe(404);
    expect((await reg("ann", "nonsense-code")).status).toBe(404);
    // Nothing was created by the failed attempts.
    const good = (await call(owner).post("/invites", {})).body;
    expect((await reg("ann", good.code)).status).toBe(200);
  });

  it("rejects a taken username with 409 and does not burn the invite", async () => {
    const invite = (await call(owner).post("/invites", { maxUses: 1 })).body;
    const taken = await reg("mika", invite.code);
    expect(taken.status).toBe(409);
    expect((await reg("ann", invite.code)).status).toBe(200);
  });

  it("rate limits guessing", async () => {
    const attempts: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await anon("/auth/register", {
        username: `g${i}`,
        displayName: "g",
        password: OWNER.password,
        inviteCode: "guess-guess",
      });
      attempts.push(r.status);
    }
    expect(attempts.at(-1)).toBe(429);
  });

  it("is closed when signup is closed, open without a code when signup is open", async () => {
    await s.close();
    s = await startTestServer({ config: { modules: { accounts: { signup: "closed", argon2 } } } });
    owner = await s.setupOwner();
    expect((await reg("ann")).status).toBe(403);
    await s.close();
    s = await startTestServer({ config: { modules: { accounts: { signup: "open", argon2 } } } });
    owner = await s.setupOwner();
    expect((await reg("ann")).status).toBe(200);
  });
});

describe("invite management", () => {
  it("previews publicly without leaking more than the name and size, and counts down", async () => {
    const invite = (await call(owner).post("/invites", { maxUses: 1 })).body;
    const preview = await s.request("GET", `/api/v1/invites/${invite.code}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ instanceName: "Friends of Tin", memberCount: 1 });
    await reg("ann", invite.code);
    const used = await s.request("GET", `/api/v1/invites/${invite.code}`);
    expect(used.status).toBe(410);
    expect((await s.request("GET", "/api/v1/invites/doesnotexist")).status).toBe(404);
  });

  it("lists own invites, lets managers see and revoke all, and hides others' from members", async () => {
    const annInvite = (await call(owner).post("/invites", {})).body;
    const ann = (await reg("ann", annInvite.code)).body;
    const bo = (await reg("bo", (await call(owner).post("/invites", {})).body.code)).body;
    const mine = (await call(ann.token).post("/invites", { maxUses: 5 })).body;
    expect((await call(ann.token).get("/invites")).body.map((i: any) => i.id)).toEqual([mine.id]);
    expect((await call(bo.token).get("/invites")).body).toEqual([]);
    expect((await call(bo.token).del(`/invites/${mine.id}`)).status).toBe(404);
    // Without MANAGE_INVITES ?all=true falls back to the caller's own.
    expect((await call(ann.token).get("/invites?all=true")).body).toHaveLength(1);
    expect((await call(owner).get("/invites?all=true")).body.length).toBeGreaterThanOrEqual(3);
    expect((await call(ann.token).del(`/invites/${mine.id}`)).status).toBe(204);
    expect((await call(ann.token).get("/invites")).body).toEqual([]);
    expect((await call(ann.token).get("/invites?include=all")).body[0].revokedAt).not.toBeNull();
  });

  it("is absent when the module is off", async () => {
    await s.close();
    s = await startTestServer({
      config: { modules: { invites: { enabled: false }, accounts: { signup: "invite-only", argon2 } } },
    });
    owner = await s.setupOwner();
    expect((await call(owner).post("/invites", {})).status).toBe(404);
    const r = await reg("ann", "whatever1");
    expect(r.body.error.code).toBe("FEATURE_DISABLED");
  });
});

describe("password reset codes", () => {
  const joined = async (name: string) => {
    const code = (await call(owner).post("/invites", {})).body.code;
    return (await reg(name, code)).body as { token: string; user: { id: string } };
  };

  it("lets an admin issue a single-use code that sets a new password and signs the user out", async () => {
    const ann = await joined("ann");
    const issued = await call(owner).post(`/admin/users/${ann.user.id}/reset-token`);
    expect(issued.status).toBe(200);
    expect(issued.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: ann.token, client: { name: "t", version: "1", platform: "node" } },
    });
    await sock.next((f) => f.t === "READY");

    const redeemed = await anon("/auth/reset", {
      code: issued.body.code.toLowerCase().replace(/-/g, " "),
      newPassword: "a brand new passphrase",
    });
    expect(redeemed.status).toBe(204);
    expect((await sock.closed).code).toBe(4004); // the live session was revoked
    expect((await call(ann.token).get("/users/@me")).status).toBe(401);
    expect((await s.login("ann", "a brand new passphrase")).status).toBe(200);
    expect((await s.login("ann", OWNER.password)).status).toBe(401);
    // Single use.
    expect(
      (await anon("/auth/reset", { code: issued.body.code, newPassword: "another new passphrase" })).status,
    ).toBe(404);
  });

  it("replaces an unused code when a new one is issued, and refuses expired codes", async () => {
    const ann = await joined("ann");
    const first = (await call(owner).post(`/admin/users/${ann.user.id}/reset-token`)).body;
    const second = (await call(owner).post(`/admin/users/${ann.user.id}/reset-token`)).body;
    expect(
      (await anon("/auth/reset", { code: first.code, newPassword: "a brand new passphrase" })).status,
    ).toBe(404);
    await s.running.ports.db.query
      .updateTable("password_reset" as never)
      .set({ expires_at: Date.now() - 1 } as never)
      .execute();
    expect(
      (await anon("/auth/reset", { code: second.code, newPassword: "a brand new passphrase" })).status,
    ).toBe(404);
  });

  it("is not available to plain members or to anyone against the owner or a peer", async () => {
    const ann = await joined("ann");
    const bo = await joined("bo");
    expect((await call(ann.token).post(`/admin/users/${bo.user.id}/reset-token`)).status).toBe(403);
    const admin = ((await call(owner).get("/roles")).body as any[]).find((r) => r.name === "Admin");
    await call(owner).put(`/members/${ann.user.id}/roles/${admin.id}`);
    expect((await call(ann.token).post(`/admin/users/${bo.user.id}/reset-token`)).status).toBe(200);
    const ownerId = (await call(owner).get("/members")).body.items.find((m: any) => m.isOwner).userId;
    expect((await call(ann.token).post(`/admin/users/${ownerId}/reset-token`)).status).toBe(403);
    expect((await call(owner).post(`/admin/users/nobody/reset-token`)).status).toBe(404);
  });

  it("applies the password policy to the new password and rate limits attempts", async () => {
    const ann = await joined("ann");
    const { code } = (await call(owner).post(`/admin/users/${ann.user.id}/reset-token`)).body;
    expect((await anon("/auth/reset", { code, newPassword: "short" })).status).toBe(400);
    // The failed attempt did not burn the code.
    expect((await anon("/auth/reset", { code, newPassword: "a brand new passphrase" })).status).toBe(204);
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await anon("/auth/reset", { code: "AAAA-BBBB-CCCC", newPassword: "a brand new passphrase" }))
        .status;
    expect(last).toBe(429);
  });
});

describe("profile, settings and presence", () => {
  it("edits the profile and tells everyone", async () => {
    const ann = await (async () =>
      (await reg("ann", (await call(owner).post("/invites", {})).body.code)).body)();
    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: owner, client: { name: "t", version: "1", platform: "node" } },
    });
    await sock.next((f) => f.t === "READY");
    const patched = await call(ann.token).patch("/users/@me", { displayName: "Annie", statusText: "brb" });
    expect(patched.body.displayName).toBe("Annie");
    expect((await sock.next((f) => f.t === "USER_UPDATE")).d).toMatchObject({
      id: ann.user.id,
      displayName: "Annie",
      statusText: "brb",
    });
    expect((await call(ann.token).patch("/users/@me", { displayName: "" })).status).toBe(400);
    sock.close();
  });

  it("syncs registered preferences, rejects unknown or invalid ones, and notifies other devices", async () => {
    const device2 = s.connect();
    await device2.next();
    device2.send({
      op: Op.IDENTIFY,
      d: { token: owner, client: { name: "t", version: "1", platform: "node" } },
    });
    await device2.next((f) => f.t === "READY");

    const ok = await call(owner).patch("/users/@me/settings", { "appearance.theme": "dark", locale: "en" });
    expect(ok.body).toEqual({ "appearance.theme": "dark", locale: "en" });
    expect((await device2.next((f) => f.t === "USER_SETTINGS_UPDATE")).d).toEqual({
      settings: { "appearance.theme": "dark", locale: "en" },
    });
    expect((await call(owner).get("/users/@me/settings")).body["appearance.theme"]).toBe("dark");

    const bad = await call(owner).patch("/users/@me/settings", {
      "appearance.theme": "neon",
      "nope.nothing": 1,
    });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details.fields)).toEqual(["appearance.theme", "nope.nothing"]);
    expect((await call(owner).get("/users/@me/settings")).body["appearance.theme"]).toBe("dark"); // all or nothing

    const general = (await call(owner).get("/channels")).body.channels[0].id;
    const muted = await call(owner).patch("/users/@me/settings", {
      [`notifications.channel.${general}`]: { level: "mentions", mutedUntil: null },
    });
    expect(muted.status).toBe(200);
    expect(
      (await call(owner).patch("/users/@me/settings", { "appearance.theme": null })).body["appearance.theme"],
    ).toBeUndefined();
    device2.close();
  });

  it("announces presence from live sockets and honours invisible", async () => {
    const ann = await (async () =>
      (await reg("ann", (await call(owner).post("/invites", {})).body.code)).body)();
    const watcher = s.connect();
    await watcher.next();
    watcher.send({
      op: Op.IDENTIFY,
      d: { token: owner, client: { name: "t", version: "1", platform: "node" } },
    });
    const ready = (await watcher.next((f) => f.t === "READY")).d as any;
    expect(ready.presence[ready.user.id]).toBe("online");

    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: ann.token, client: { name: "t", version: "1", platform: "node" } },
    });
    await sock.next((f) => f.t === "READY");
    expect(
      (await watcher.next((f) => f.t === "PRESENCE_UPDATE" && (f.d as any).userId === ann.user.id)).d,
    ).toMatchObject({ status: "online" });

    sock.send({ op: Op.COMMAND, d: { cmd: "presence.set", args: { status: "dnd" }, id: 1 } });
    expect(
      (await watcher.next((f) => f.t === "PRESENCE_UPDATE" && (f.d as any).status === "dnd")).d,
    ).toMatchObject({ userId: ann.user.id });
    sock.send({ op: Op.COMMAND, d: { cmd: "presence.set", args: { status: "invisible" }, id: 2 } });
    expect(
      (await watcher.next((f) => f.t === "PRESENCE_UPDATE" && (f.d as any).status === "offline")).d,
    ).toMatchObject({ userId: ann.user.id });
    sock.send({ op: Op.COMMAND, d: { cmd: "presence.set", args: { status: "bogus" }, id: 3 } });
    expect((await sock.next((f) => f.op === Op.COMMAND_RESULT && (f.d as any).id === 3)).d).toMatchObject({
      ok: false,
    });
    watcher.close();
    sock.close();
  });
});
