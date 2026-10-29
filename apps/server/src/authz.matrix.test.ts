// SPDX-License-Identifier: AGPL-3.0-or-later
import sharp from "sharp";
import { PERM, permissionsToString } from "@tincan/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Op } from "@tincan/shared";
import { OWNER, startTestServer, type TestServer } from "./testing/harness.js";

/**
 * Authorisation matrix (16 §5, 11 §2, 15 S-04/S-05): every endpoint that takes a permission decision,
 * for each representative member, in three channel situations. The tables below are the specification:
 * a cell is the HTTP status the actor must get. The same run asserts that a refusal never carries data.
 *
 *   owner       the instance owner
 *   admin       holds the Admin role (everything except ADMINISTRATOR)
 *   mod         holds the Moderator role
 *   member      only @everyone
 *   restricted  @everyone, but a member overwrite denies SEND_MESSAGES, ATTACH_FILES and READ_HISTORY
 *   outsider    @everyone, but a member overwrite denies VIEW_CHANNEL
 *   anon        no credentials
 */
const ACTORS = ["owner", "admin", "mod", "member", "restricted", "outsider"] as const;
type Actor = (typeof ACTORS)[number];
const SCENARIOS = ["open", "private", "readonly"] as const;
type Scenario = (typeof SCENARIOS)[number];

type Cell = number | "skip";
/** owner, admin, mod, member, restricted, outsider */
const row = (...c: [Cell, Cell, Cell, Cell, Cell, Cell]): Record<Actor, Cell> => ({
  owner: c[0],
  admin: c[1],
  mod: c[2],
  member: c[3],
  restricted: c[4],
  outsider: c[5],
});

let s: TestServer;
const token = {} as Record<Actor, string>;
const userId = {} as Record<Actor, string>;
const channel = {} as Record<Scenario, string>;
const roleId = {} as Record<"everyone" | "mod" | "admin" | "scratch", string>;

const call = (as: Actor | "anon", method: string, path: string, body?: unknown) =>
  s.request(method, `/api/v1${path}`, { ...(as === "anon" ? {} : { token: token[as] }), body });

/** A message by `author` in a scenario channel, bypassing nothing: through the real endpoint. */
async function seed(author: Actor, scen: Scenario, content = "seed message"): Promise<string> {
  await s.running.ports.pubsub.kv.del(`rl:msg:${userId[author]}:${channel[scen]}`);
  const r = await call(author, "POST", `/channels/${channel[scen]}/messages`, { content });
  if (r.status !== 201)
    throw new Error(`seed failed as ${author} in ${scen}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}

beforeAll(async () => {
  s = await startTestServer({
    config: {
      modules: {
        accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
        "text-chat": { createRate: { max: 1000, windowSecs: 10 } },
      },
    },
  });
  token.owner = await s.setupOwner();
  userId.owner = (await call("owner", "GET", "/members")).body.items[0].userId;
  for (const a of ["admin", "mod", "member", "restricted", "outsider"] as const) {
    const u = await s.register(a);
    token[a] = u.token;
    userId[a] = u.id;
  }
  const roles = (await call("owner", "GET", "/roles")).body as {
    id: string;
    name: string;
    isDefault: boolean;
  }[];
  roleId.everyone = roles.find((r) => r.isDefault)!.id;
  roleId.mod = roles.find((r) => r.name === "Moderator")!.id;
  roleId.admin = roles.find((r) => r.name === "Admin")!.id;
  // A role nobody holds, for cases that edit overwrites without disturbing the scenario channels.
  roleId.scratch = (await call("owner", "POST", "/roles", { name: "Scratch", position: 1 })).body
    .id as string;
  await call("owner", "PUT", `/members/${userId.admin}/roles/${roleId.admin}`);
  await call("owner", "PUT", `/members/${userId.mod}/roles/${roleId.mod}`);

  const ow = (id: string, type: "role" | "member", target: string, allow: bigint, deny: bigint) =>
    call("owner", "PUT", `/channels/${id}/overwrites/${type}/${target}`, {
      allow: permissionsToString(allow),
      deny: permissionsToString(deny),
    });
  for (const scen of SCENARIOS) {
    const id = (await call("owner", "POST", "/channels", { type: "text", name: `${scen}-chan` })).body
      .id as string;
    channel[scen] = id;
    await ow(id, "member", userId.restricted, 0n, PERM.SEND_MESSAGES | PERM.ATTACH_FILES | PERM.READ_HISTORY);
    await ow(id, "member", userId.outsider, 0n, PERM.VIEW_CHANNEL);
    if (scen === "private") {
      await ow(id, "role", roleId.everyone, 0n, PERM.VIEW_CHANNEL);
      await ow(id, "role", roleId.mod, PERM.VIEW_CHANNEL, 0n);
      await ow(id, "role", roleId.admin, PERM.VIEW_CHANNEL, 0n);
    }
    if (scen === "readonly") {
      await ow(id, "role", roleId.everyone, 0n, PERM.SEND_MESSAGES);
      await ow(id, "role", roleId.mod, PERM.SEND_MESSAGES, 0n);
      await ow(id, "role", roleId.admin, PERM.SEND_MESSAGES, 0n);
    }
  }
});
afterAll(async () => {
  await s.close();
});

interface ChannelCase {
  name: string;
  /** Per scenario, what each actor gets. */
  expect: Record<Scenario, Record<Actor, Cell>>;
  run(as: Actor | "anon", scen: Scenario): Promise<{ status: number; body: unknown }>;
}

// What the "view-only" parts of a scenario give each actor: private hides the channel from everyone below moderator.
const hiddenFromPlain: Record<Actor, Cell> = row(0, 0, 0, 404, 404, 404);
const withView = (open: Record<Actor, Cell>, scenario: Scenario): Record<Actor, Cell> => {
  if (scenario !== "private") return open;
  const out = { ...open };
  for (const a of ["member", "restricted", "outsider"] as const) out[a] = hiddenFromPlain[a];
  return out;
};

const channelCases: ChannelCase[] = [
  {
    name: "read history",
    expect: {
      open: row(200, 200, 200, 200, 200, 404),
      private: withView(row(200, 200, 200, 200, 200, 404), "private"),
      readonly: row(200, 200, 200, 200, 200, 404),
    },
    run: (as, scen) => call(as, "GET", `/channels/${channel[scen]}/messages`),
  },
  {
    name: "send a message",
    expect: {
      open: row(201, 201, 201, 201, 403, 404),
      private: withView(row(201, 201, 201, 201, 403, 404), "private"),
      readonly: row(201, 201, 201, 403, 403, 404),
    },
    run: (as, scen) =>
      call(as, "POST", `/channels/${channel[scen]}/messages`, { content: `hello from ${as}` }),
  },
  {
    name: "edit someone else's message",
    expect: {
      open: row(403, 403, "skip", 403, 403, 404),
      private: withView(row(403, 403, "skip", 403, 403, 404), "private"),
      readonly: row(403, 403, "skip", 403, 403, 404),
    },
    run: async (as, scen) => {
      const m = await seed("mod", scen);
      return call(as, "PATCH", `/channels/${channel[scen]}/messages/${m}`, { content: "tampered" });
    },
  },
  {
    name: "delete someone else's message",
    expect: {
      open: row(204, 204, "skip", 403, 403, 404),
      private: withView(row(204, 204, "skip", 403, 403, 404), "private"),
      readonly: row(204, 204, "skip", 403, 403, 404),
    },
    run: async (as, scen) => {
      const m = await seed("mod", scen);
      return call(as, "DELETE", `/channels/${channel[scen]}/messages/${m}`);
    },
  },
  {
    name: "delete a message with MANAGE_MESSAGES held by a moderator",
    expect: {
      open: row("skip", "skip", 204, "skip", "skip", "skip"),
      private: row("skip", "skip", 204, "skip", "skip", "skip"),
      readonly: row("skip", "skip", 204, "skip", "skip", "skip"),
    },
    run: async (as, scen) => {
      const m = await seed("admin", scen);
      return call(as, "DELETE", `/channels/${channel[scen]}/messages/${m}`);
    },
  },
  {
    name: "pin a message",
    expect: {
      open: row(204, 204, 204, 403, 403, 404),
      private: withView(row(204, 204, 204, 403, 403, 404), "private"),
      readonly: row(204, 204, 204, 403, 403, 404),
    },
    run: async (as, scen) => {
      const m = await seed("mod", scen);
      return call(as, "PUT", `/channels/${channel[scen]}/pins/${m}`);
    },
  },
  {
    name: "list pins",
    expect: {
      open: row(200, 200, 200, 200, 403, 404),
      private: withView(row(200, 200, 200, 200, 403, 404), "private"),
      readonly: row(200, 200, 200, 200, 403, 404),
    },
    run: (as, scen) => call(as, "GET", `/channels/${channel[scen]}/pins`),
  },
  {
    name: "acknowledge",
    expect: {
      open: row(200, 200, 200, 200, 200, 404),
      private: withView(row(200, 200, 200, 200, 200, 404), "private"),
      readonly: row(200, 200, 200, 200, 200, 404),
    },
    run: async (as, scen) => {
      const m = await seed("mod", scen);
      return call(as, "POST", `/channels/${channel[scen]}/ack`, { messageId: m });
    },
  },
  {
    name: "search inside the channel",
    expect: {
      open: row(200, 200, 200, 200, 200, 200),
      private: row(200, 200, 200, 200, 200, 200),
      readonly: row(200, 200, 200, 200, 200, 200),
    },
    run: (as, scen) => call(as, "GET", `/search?q=hello&channelId=${channel[scen]}`),
  },
  {
    name: "edit the channel",
    expect: {
      open: row(200, 200, 403, 403, 403, 403),
      private: row(200, 200, 403, 403, 403, 403),
      readonly: row(200, 200, 403, 403, 403, 403),
    },
    run: (as, scen) => call(as, "PATCH", `/channels/${channel[scen]}`, { topic: `set by ${as}` }),
  },
  {
    name: "read the channel's overwrites",
    expect: {
      open: row(200, 200, 403, 403, 403, 403),
      private: row(200, 200, 403, 403, 403, 403),
      readonly: row(200, 200, 403, 403, 403, 403),
    },
    run: (as, scen) => call(as, "GET", `/channels/${channel[scen]}/overwrites`),
  },
  {
    name: "set an overwrite on a lower role",
    expect: {
      open: row(200, 200, 403, 403, 403, 403),
      private: row(200, 200, 403, 403, 403, 403),
      readonly: row(200, 200, 403, 403, 403, 403),
    },
    run: (as, scen) =>
      call(as, "PUT", `/channels/${channel[scen]}/overwrites/role/${roleId.scratch}`, {
        allow: "0",
        deny: permissionsToString(PERM.EMBED_LINKS),
      }),
  },
];

describe("authorisation matrix: channel routes", () => {
  for (const c of channelCases) {
    for (const scen of SCENARIOS) {
      for (const as of ACTORS) {
        const want = c.expect[scen][as];
        if (want === "skip") continue;
        it(`${c.name} · ${scen} channel · ${as} → ${want}`, async () => {
          const res = await c.run(as, scen);
          expect(res.status, JSON.stringify(res.body)).toBe(want);
          if (want >= 400) {
            // A refusal carries the error envelope and nothing else: no message, channel or member data.
            expect(Object.keys(res.body as object)).toEqual(["error"]);
          }
        });
      }
      it(`${c.name} · ${scen} channel · anon → 401`, async () => {
        const res = await c.run("anon", scen);
        expect(res.status).toBe(401);
        expect(Object.keys(res.body as object)).toEqual(["error"]);
      });
    }
  }
});

describe("authorisation matrix: instance routes", () => {
  interface InstanceCase {
    name: string;
    expect: Record<Actor, Cell>;
    run(as: Actor | "anon"): Promise<{ status: number; body: unknown }>;
    anon?: number;
  }
  const cases: InstanceCase[] = [
    {
      name: "create a channel",
      expect: row(201, 201, 403, 403, 403, 403),
      run: (as) => call(as, "POST", "/channels", { type: "text", name: `by-${as}` }),
    },
    {
      name: "delete a channel",
      expect: row(204, 204, 403, 403, 403, 403),
      run: async (as) => {
        const id = (await call("owner", "POST", "/channels", { type: "text", name: "doomed" })).body
          .id as string;
        return call(as, "DELETE", `/channels/${id}`);
      },
    },
    {
      name: "create a category",
      expect: row(201, 201, 403, 403, 403, 403),
      run: (as) => call(as, "POST", "/categories", { name: `cat-${as}` }),
    },
    {
      name: "create a role",
      expect: row(201, 201, 403, 403, 403, 403),
      run: (as) => call(as, "POST", "/roles", { name: `role-${as}` }),
    },
    {
      name: "delete a role below one's own",
      expect: row(204, 204, 403, 403, 403, 403),
      run: async (as) => {
        const id = (await call("owner", "POST", "/roles", { name: "temp", position: 1 })).body.id as string;
        return call(as, "DELETE", `/roles/${id}`);
      },
    },
    {
      name: "edit the Admin role",
      expect: row(200, 403, 403, 403, 403, 403),
      run: (as) => call(as, "PATCH", `/roles/${roleId.admin}`, { hoist: true }),
    },
    {
      name: "edit the Moderator role",
      expect: row(200, 200, 403, 403, 403, 403),
      run: (as) => call(as, "PATCH", `/roles/${roleId.mod}`, { hoist: true }),
    },
    {
      name: "give a member the Moderator role",
      expect: row(204, 204, 403, 403, 403, 403),
      run: (as) =>
        call(as, "PUT", `/members/${userId.member}/roles/${roleId.mod}`).then(async (r) => {
          await call("owner", "DELETE", `/members/${userId.member}/roles/${roleId.mod}`);
          return r;
        }),
    },
    {
      name: "give a member the Admin role",
      expect: row(204, 403, 403, 403, 403, 403),
      run: (as) =>
        call(as, "PUT", `/members/${userId.member}/roles/${roleId.admin}`).then(async (r) => {
          await call("owner", "DELETE", `/members/${userId.member}/roles/${roleId.admin}`);
          return r;
        }),
    },
    { name: "list roles", expect: row(200, 200, 200, 200, 200, 200), run: (as) => call(as, "GET", "/roles") },
    {
      name: "list members",
      expect: row(200, 200, 200, 200, 200, 200),
      run: (as) => call(as, "GET", "/members"),
    },
    {
      name: "list channels",
      expect: row(200, 200, 200, 200, 200, 200),
      run: (as) => call(as, "GET", "/channels"),
    },
    {
      name: "rename another member's nickname",
      expect: row(200, 200, 200, "skip", 403, 403),
      run: (as) => call(as, "PATCH", `/members/${userId.member}`, { nickname: `by ${as}` }),
    },
    {
      name: "rename the owner's nickname",
      expect: row(200, 403, 403, 403, 403, 403),
      run: (as) => call(as, "PATCH", `/members/${userId.owner}`, { nickname: `by ${as}` }),
    },
    {
      name: "explain a member's permissions",
      expect: row(200, 200, 403, 403, 403, 403),
      run: (as) => call(as, "GET", `/members/${userId.member}/permissions?channelId=${channel.open}`),
    },
    {
      name: "read the module report",
      expect: row(200, 403, 403, 403, 403, 403),
      run: (as) => call(as, "GET", "/admin/modules"),
    },
    {
      name: "rename the instance",
      expect: row(200, 403, 403, 403, 403, 403),
      run: (as) => call(as, "PATCH", "/admin/instance", { name: `Place ${as}` }),
    },
    {
      name: "issue a reset code for a member",
      expect: row(200, 200, 403, 403, 403, 403),
      run: (as) => call(as, "POST", `/admin/users/${userId.member}/reset-token`),
    },
    {
      name: "issue a reset code for the owner",
      expect: row(200, 403, 403, 403, 403, 403),
      run: (as) => call(as, "POST", `/admin/users/${userId.owner}/reset-token`),
    },
    {
      name: "create an invite",
      expect: row(201, 201, 201, 201, 201, 201),
      run: (as) => call(as, "POST", "/invites", {}),
    },
    {
      name: "create an invite that grants Moderator",
      expect: row(201, 201, 403, 403, 403, 403),
      run: (as) => call(as, "POST", "/invites", { defaultRoleId: roleId.mod }),
    },
    {
      name: "create an invite that grants Admin",
      expect: row(201, 403, 403, 403, 403, 403),
      run: (as) => call(as, "POST", "/invites", { defaultRoleId: roleId.admin }),
    },
    {
      name: "revoke someone else's invite",
      expect: row(204, 204, "skip", 404, 404, 404),
      run: async (as) => {
        const id = (await call("mod", "POST", "/invites", {})).body.id as string;
        return call(as, "DELETE", `/invites/${id}`);
      },
    },
    { name: "upload a file", expect: row(201, 201, 201, 201, 201, 201), run: (as) => upload(as) },
    {
      name: "read the search index",
      expect: row(200, 200, 200, 200, 200, 200),
      run: (as) => call(as, "GET", "/search?q=hello"),
    },
    {
      name: "change one's own synced settings",
      expect: row(200, 200, 200, 200, 200, 200),
      run: (as) => call(as, "PATCH", "/users/@me/settings", { locale: "en" }),
    },
  ];

  async function upload(as: Actor | "anon") {
    const f = new FormData();
    f.set("file", new Blob(["hello"], { type: "text/plain" }), "a.txt");
    return s.request("POST", "/api/v1/uploads", { ...(as === "anon" ? {} : { token: token[as] }), form: f });
  }

  for (const c of cases) {
    for (const as of ACTORS) {
      const want = c.expect[as];
      if (want === "skip") continue;
      it(`${c.name} · ${as} → ${want}`, async () => {
        const res = await c.run(as);
        expect(res.status, JSON.stringify(res.body)).toBe(want);
        if (want >= 400) expect(Object.keys(res.body as object)).toEqual(["error"]);
      });
    }
    it(`${c.name} · anon → 401`, async () => {
      const res = await c.run("anon");
      expect(res.status).toBe(401);
    });
  }
});

describe("no data leaks through other doors", () => {
  it("search returns private-channel text only to those who can read the channel now", async () => {
    await seed("mod", "private", "zebracrossing in private");
    await seed("mod", "open", "zebracrossing in open");
    await s.running.outbox.drain();
    const hits = async (as: Actor) =>
      ((await call(as, "GET", "/search?q=zebracrossing")).body.items as { content: string }[])
        .map((m) => m.content)
        .sort();
    expect(await hits("owner")).toEqual(["zebracrossing in open", "zebracrossing in private"]);
    expect(await hits("admin")).toEqual(["zebracrossing in open", "zebracrossing in private"]);
    expect(await hits("mod")).toEqual(["zebracrossing in open", "zebracrossing in private"]);
    expect(await hits("member")).toEqual(["zebracrossing in open"]);
    // A member overwrite that removes reading hides both the channel's history and its search hits.
    expect(await hits("restricted")).toEqual([]);
    expect(await hits("outsider")).toEqual([]);
  });

  it("READY and GET /channels list only what the member may see, with no overwrites or hidden names", async () => {
    for (const as of ACTORS) {
      const list = (await call(as, "GET", "/channels")).body as {
        channels: { id: string; name: string }[];
        permissions: Record<string, string>;
      };
      const ids = list.channels.map((c) => c.id);
      const expectedHidden =
        as === "outsider"
          ? [channel.open, channel.private, channel.readonly]
          : ["member", "restricted"].includes(as)
            ? [channel.private]
            : [];
      for (const hidden of expectedHidden) {
        expect(ids, `${as} sees ${hidden}`).not.toContain(hidden);
        expect(list.permissions[hidden]).toBeUndefined();
      }
      const sock = s.connect();
      await sock.next();
      sock.send({
        op: Op.IDENTIFY,
        d: { token: token[as], client: { name: "t", version: "1", platform: "node" } },
      });
      const ready = (await sock.next((f) => f.t === "READY")).d as {
        channels: { id: string }[];
        channelPermissions: Record<string, string>;
      };
      expect(ready.channels.map((c) => c.id).sort()).toEqual([...ids].sort());
      expect(Object.keys(ready.channelPermissions).sort()).toEqual(Object.keys(list.permissions).sort());
      sock.close();
    }
  });

  it("files attached in a private channel are not served to those who cannot see it", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#00aa00" } })
      .png()
      .toBuffer();
    const f = new FormData();
    f.set("file", new Blob([png], { type: "image/png" }), "secret.png");
    const up = (await s.request("POST", "/api/v1/uploads", { token: token.mod, form: f })).body;
    await s.running.ports.pubsub.kv.del(`rl:msg:${userId.mod}:${channel.private}`);
    await call("mod", "POST", `/channels/${channel.private}/messages`, {
      content: "with file",
      attachmentIds: [up.id],
    });
    const get = (as: Actor) => s.request("GET", `/api/v1/files/${up.id}/secret.png`, { token: token[as] });
    for (const as of ["owner", "admin", "mod"] as const) expect((await get(as)).status, as).toBe(200);
    for (const as of ["member", "restricted", "outsider"] as const) {
      const r = await get(as);
      expect(r.status, as).toBe(404);
      expect(r.bytes.equals(png)).toBe(false);
    }
  });

  it("a member cannot learn that a private channel exists from error responses", async () => {
    const hidden = await call("member", "GET", `/channels/${channel.private}/messages`);
    const missing = await call("member", "GET", "/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV/messages");
    expect(hidden.status).toBe(missing.status);
    expect((hidden.body as { error: { code: string } }).error.code).toBe(
      (missing.body as { error: { code: string } }).error.code,
    );
  });
});

describe("privilege escalation", () => {
  it("a role manager cannot hand out a permission they lack, through roles, overwrites or invites", async () => {
    // Admin lacks ADMINISTRATOR (11 §2.2): every path to it is closed.
    const make = await call("admin", "POST", "/roles", {
      name: "root",
      permissions: permissionsToString(PERM.ADMINISTRATOR),
    });
    expect(make.status).toBe(403);
    const mod = await call("admin", "PATCH", `/roles/${roleId.mod}`, {
      permissions: permissionsToString(PERM.ADMINISTRATOR | PERM.VIEW_CHANNEL),
    });
    expect(mod.status).toBe(403);
    const ev = await call("admin", "PATCH", `/roles/${roleId.everyone}`, {
      permissions: permissionsToString(PERM.ADMINISTRATOR),
    });
    expect(ev.status).toBe(403);
    // Overwrites only reach per-channel bits, whatever is sent; an instance-wide bit is ignored.
    const put = await call("admin", "PUT", `/channels/${channel.open}/overwrites/role/${roleId.everyone}`, {
      allow: permissionsToString(PERM.ADMINISTRATOR | PERM.MANAGE_ROLES),
      deny: "0",
    });
    expect(put.status).toBe(200);
    expect(put.body.allow).toBe("0");
    expect((await call("member", "POST", "/roles", { name: "still no" })).status).toBe(403);
    await call("owner", "DELETE", `/channels/${channel.open}/overwrites/role/${roleId.everyone}`);
  });

  it("nobody can promote themselves or a peer, or touch the owner", async () => {
    expect((await call("admin", "PUT", `/members/${userId.admin}/roles/${roleId.admin}`)).status).toBe(403);
    expect((await call("mod", "PUT", `/members/${userId.mod}/roles/${roleId.mod}`)).status).toBe(403);
    expect((await call("admin", "PUT", `/members/${userId.mod}/roles/${roleId.admin}`)).status).toBe(403);
    expect((await call("admin", "DELETE", `/members/${userId.owner}/roles/${roleId.mod}`)).status).toBe(403);
    // A moderator cannot demote an admin by editing their roles either.
    expect((await call("mod", "DELETE", `/members/${userId.admin}/roles/${roleId.admin}`)).status).toBe(403);
    const roles = (await call("owner", "GET", `/members/${userId.admin}`)).body.roleIds as string[];
    expect(roles).toContain(roleId.admin);
  });

  it("an overwrite cannot be used to see or write where the editor could not", async () => {
    // The moderator can see and write in the private channel via the Moderator overwrite, but has no
    // MANAGE_CHANNELS, so cannot widen it.
    expect(
      (
        await call("mod", "PUT", `/channels/${channel.private}/overwrites/role/${roleId.everyone}`, {
          allow: permissionsToString(PERM.VIEW_CHANNEL),
          deny: "0",
        })
      ).status,
    ).toBe(403);
    expect((await call("member", "GET", `/channels/${channel.private}/messages`)).status).toBe(404);
    // An admin may not grant Admin-role overwrite bits that the channel denies the admin themself.
    await call("owner", "PUT", `/channels/${channel.open}/overwrites/role/${roleId.admin}`, {
      allow: "0",
      deny: permissionsToString(PERM.MANAGE_MESSAGES),
    });
    const grant = await call("admin", "PUT", `/channels/${channel.open}/overwrites/role/${roleId.mod}`, {
      allow: permissionsToString(PERM.MANAGE_MESSAGES),
      deny: "0",
    });
    expect(grant.status).toBe(403);
    await call("owner", "DELETE", `/channels/${channel.open}/overwrites/role/${roleId.admin}`);
  });

  it("cookie sessions need the CSRF header for every mutation", async () => {
    const login = await s.login("member", OWNER.password);
    const cookie = login.setCookie!.split(";")[0]!;
    const without = await s.request("POST", `/api/v1/channels/${channel.open}/messages`, {
      cookie,
      body: { content: "forged" },
    });
    expect(without.status).toBe(403);
    const withHeader = await s.request("POST", `/api/v1/channels/${channel.open}/messages`, {
      cookie,
      headers: { "x-tincan-csrf": "1" },
      body: { content: "legit" },
    });
    expect(withHeader.status).toBe(201);
  });

  it("a revoked session loses access at once, including on live sockets", async () => {
    const login = await s.login("restricted", OWNER.password);
    const t = login.body.token as string;
    const sock = s.connect();
    await sock.next();
    sock.send({ op: Op.IDENTIFY, d: { token: t, client: { name: "t", version: "1", platform: "node" } } });
    await sock.next((f) => f.t === "READY");
    const sessions = (await s.request("GET", "/api/v1/auth/sessions", { token: t })).body as {
      id: string;
      current: boolean;
    }[];
    expect((await s.request("POST", "/api/v1/auth/logout", { token: t })).status).toBe(204);
    expect((await sock.closed).code).toBe(4004);
    expect((await s.request("GET", "/api/v1/channels", { token: t })).status).toBe(401);
    void sessions;
  });
});
