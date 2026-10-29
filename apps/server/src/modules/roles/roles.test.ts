// SPDX-License-Identifier: AGPL-3.0-or-later
import { Op, PERM, permissionsToString } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RolesApi } from "./api.js";
import { startTestServer, type TestServer, type TestSocket } from "../../testing/harness.js";

let s: TestServer;
let owner: string;

beforeEach(async () => {
  s = await startTestServer();
  owner = await s.setupOwner();
});
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

async function roleByName(token: string, name: string): Promise<{ id: string; position: number }> {
  const roles = (await api(token).get("/roles")).body as { id: string; name: string; position: number }[];
  return roles.find((r) => r.name === name)!;
}

async function identified(token: string): Promise<{ sock: TestSocket; ready: Record<string, any> }> {
  const sock = s.connect();
  await sock.next();
  sock.send({ op: Op.IDENTIFY, d: { token, client: { name: "t", version: "1", platform: "node" } } });
  const ready = (await sock.next((f) => f.t === "READY")).d as Record<string, any>;
  return { sock, ready };
}

describe("setup seeds the defaults", () => {
  it("creates @everyone, Moderator and Admin, #general and Lounge", async () => {
    const roles = (await api(owner).get("/roles")).body as {
      name: string;
      isDefault: boolean;
      position: number;
    }[];
    expect(roles.map((r) => r.name)).toEqual(["@everyone", "Moderator", "Admin"]);
    expect(roles[0]!.isDefault).toBe(true);
    const list = (await api(owner).get("/channels")).body as {
      channels: { name: string; type: string }[];
      categories: unknown[];
    };
    expect(list.channels.map((c) => `${c.type}:${c.name}`).sort()).toEqual(["text:general", "voice:Lounge"]);
    expect(list.categories).toHaveLength(2);
  });

  it("sends roles, channels, members and permissions in READY", async () => {
    const { sock, ready } = await identified(owner);
    expect(ready.roles).toHaveLength(3);
    expect(ready.channels).toHaveLength(2);
    expect(ready.members).toHaveLength(1);
    expect(ready.members[0].isOwner).toBe(true);
    expect(BigInt(ready.permissions)).toBeGreaterThan(0n);
    expect(Object.keys(ready.channelPermissions)).toHaveLength(2);
    sock.close();
  });

  it("gives a new member the @everyone bundle and no more", async () => {
    const ann = await s.register("ann");
    const { channels } = (await api(ann.token).get("/channels")).body as { channels: { id: string }[] };
    expect(channels).toHaveLength(2);
    const denied = await api(ann.token).post("/roles", { name: "Sneaky" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PERMISSION_DENIED");
    const channel = await api(ann.token).post("/channels", { type: "text", name: "mine" });
    expect(channel.status).toBe(403);
  });
});

describe("roles and the hierarchy", () => {
  it("lets an admin create, edit and delete roles below their own rank", async () => {
    const ann = await s.register("ann");
    const admin = await roleByName(owner, "Admin");
    expect((await api(owner).put(`/members/${ann.id}/roles/${admin.id}`)).status).toBe(204);

    const created = await api(ann.token).post("/roles", {
      name: "Gamers",
      color: "#336699",
      permissions: permissionsToString(PERM.SEND_MESSAGES),
    });
    expect(created.status).toBe(201);
    expect(created.body.position).toBeLessThan(admin.position + 1);
    const edit = await api(ann.token).patch(`/roles/${created.body.id}`, { name: "Players", hoist: true });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ name: "Players", hoist: true });
    expect((await api(ann.token).del(`/roles/${created.body.id}`)).status).toBe(204);
  });

  it("refuses privilege escalation: granting a bit the actor lacks, editing own or higher roles", async () => {
    const ann = await s.register("ann");
    const bo = await s.register("bo");
    const admin = await roleByName(owner, "Admin");
    const mod = await roleByName(owner, "Moderator");
    await api(owner).put(`/members/${ann.id}/roles/${admin.id}`);

    // ADMINISTRATOR is not in the Admin bundle, so an Admin cannot hand it out.
    const grab = await api(ann.token).post("/roles", {
      name: "Root",
      permissions: permissionsToString(PERM.ADMINISTRATOR),
    });
    expect(grab.status).toBe(403);
    // Cannot edit the role they hold, nor a higher one.
    expect((await api(ann.token).patch(`/roles/${admin.id}`, { permissions: "0" })).status).toBe(403);
    // Cannot add ADMINISTRATOR to a lower role either.
    expect(
      (
        await api(ann.token).patch(`/roles/${mod.id}`, {
          permissions: permissionsToString(PERM.ADMINISTRATOR),
        })
      ).status,
    ).toBe(403);
    // A moderator cannot manage roles at all, even for themselves.
    await api(owner).put(`/members/${bo.id}/roles/${mod.id}`);
    expect((await api(bo.token).put(`/members/${bo.id}/roles/${admin.id}`)).status).toBe(403);
    // And an Admin cannot assign a role to a peer or to the owner.
    const peer = await s.register("cy");
    await api(owner).put(`/members/${peer.id}/roles/${admin.id}`);
    expect((await api(ann.token).put(`/members/${peer.id}/roles/${mod.id}`)).status).toBe(403);
    const me = (await api(owner).get("/members")).body.items.find((m: any) => m.isOwner);
    expect((await api(ann.token).put(`/members/${me.userId}/roles/${mod.id}`)).status).toBe(403);
    expect((await api(ann.token).del(`/members/${me.userId}/roles/${mod.id}`)).status).toBe(403);
  });

  it("keeps role positions contiguous when a role is inserted, moved and deleted", async () => {
    const a = (await api(owner).post("/roles", { name: "A", position: 1 })).body;
    const b = (await api(owner).post("/roles", { name: "B", position: 1 })).body;
    let names = ((await api(owner).get("/roles")).body as { name: string; position: number }[]).map(
      (r) => `${r.position}:${r.name}`,
    );
    expect(names).toEqual(["0:@everyone", "1:B", "2:A", "3:Moderator", "4:Admin"]);
    await api(owner).patch(`/roles/${b.id}`, { position: 4 });
    await api(owner).del(`/roles/${a.id}`);
    names = ((await api(owner).get("/roles")).body as { name: string; position: number }[]).map(
      (r) => `${r.position}:${r.name}`,
    );
    expect(names).toEqual(["0:@everyone", "1:Moderator", "2:Admin", "3:B"]);
  });

  it("does not let anyone but the owner edit or delete @everyone's identity", async () => {
    const everyone = await roleByName(owner, "@everyone");
    expect((await api(owner).del(`/roles/${everyone.id}`)).status).toBe(403);
    const moved = await api(owner).patch(`/roles/${everyone.id}`, { position: 3 });
    expect(moved.status).toBe(403);
  });

  it("changes nicknames under the hierarchy rules", async () => {
    const ann = await s.register("ann");
    const bo = await s.register("bo");
    const mod = await roleByName(owner, "Moderator");
    expect((await api(ann.token).patch("/members/@me", { nickname: "Annie" })).body.nickname).toBe("Annie");
    expect((await api(bo.token).patch(`/members/${ann.id}`, { nickname: "x" })).status).toBe(403);
    await api(owner).put(`/members/${bo.id}/roles/${mod.id}`);
    expect((await api(bo.token).patch(`/members/${ann.id}`, { nickname: "Ann!" })).status).toBe(200);
    const meOwner = (await api(owner).get("/members")).body.items.find((m: any) => m.isOwner);
    expect((await api(bo.token).patch(`/members/${meOwner.userId}`, { nickname: "boss" })).status).toBe(403);
  });
});

describe("channel overwrites and live enforcement", () => {
  it("hides a channel from @everyone, tells live sockets, and shows it again", async () => {
    const ann = await s.register("ann");
    const { channels } = (await api(owner).get("/channels")).body as {
      channels: { id: string; name: string }[];
    };
    const general = channels.find((c) => c.name === "general")!;
    const everyone = await roleByName(owner, "@everyone");

    const { sock } = await identified(ann.token);
    const put = await api(owner).put(`/channels/${general.id}/overwrites/role/${everyone.id}`, {
      allow: "0",
      deny: permissionsToString(PERM.VIEW_CHANNEL),
    });
    expect(put.status).toBe(200);
    // Enforcement is in place when the call returns; the socket hears about it.
    const gone = await sock.next((f) => f.t === "CHANNEL_DELETE");
    expect((gone.d as { channelId: string }).channelId).toBe(general.id);
    const update = await sock.next((f) => f.t === "PERMISSIONS_UPDATE");
    expect(Object.keys((update.d as { channels: object }).channels)).toHaveLength(1);
    expect(((await api(ann.token).get("/channels")).body as { channels: unknown[] }).channels).toHaveLength(
      1,
    );

    // The owner is not affected by overwrites.
    expect(((await api(owner).get("/channels")).body as { channels: unknown[] }).channels).toHaveLength(2);

    expect((await api(owner).del(`/channels/${general.id}/overwrites/role/${everyone.id}`)).status).toBe(204);
    const back = await sock.next((f) => f.t === "CHANNEL_CREATE");
    expect((back.d as { channel: { id: string } }).channel.id).toBe(general.id);
    sock.close();
  });

  it("applies a member overwrite on top of role overwrites and reports the steps", async () => {
    const ann = await s.register("ann");
    const { channels } = (await api(owner).get("/channels")).body as {
      channels: { id: string; name: string }[];
    };
    const general = channels.find((c) => c.name === "general")!;
    const everyone = await roleByName(owner, "@everyone");
    await api(owner).put(`/channels/${general.id}/overwrites/role/${everyone.id}`, {
      allow: "0",
      deny: permissionsToString(PERM.SEND_MESSAGES),
    });
    await api(owner).put(`/channels/${general.id}/overwrites/member/${ann.id}`, {
      allow: permissionsToString(PERM.SEND_MESSAGES),
      deny: "0",
    });
    const explain = await api(owner).get(`/members/${ann.id}/permissions?channelId=${general.id}`);
    expect(explain.status).toBe(200);
    expect(explain.body.steps.map((x: { step: string }) => x.step)).toContain("member overwrite");
    expect((BigInt(explain.body.permissions) & PERM.SEND_MESSAGES) !== 0n).toBe(true);
    // Only people who manage roles may look.
    expect((await api(ann.token).get(`/members/${ann.id}/permissions?channelId=${general.id}`)).status).toBe(
      403,
    );
  });

  it("will not let an admin allow a bit they lack in the channel, or overwrite a higher role", async () => {
    const ann = await s.register("ann");
    const admin = await roleByName(owner, "Admin");
    await api(owner).put(`/members/${ann.id}/roles/${admin.id}`);
    const { channels } = (await api(owner).get("/channels")).body as {
      channels: { id: string; name: string }[];
    };
    const general = channels.find((c) => c.name === "general")!;
    const mod = await roleByName(owner, "Moderator");
    // Take MANAGE_MESSAGES away from Admins here, then try to grant it.
    await api(owner).put(`/channels/${general.id}/overwrites/role/${admin.id}`, {
      allow: "0",
      deny: permissionsToString(PERM.MANAGE_MESSAGES),
    });
    const grant = await api(ann.token).put(`/channels/${general.id}/overwrites/role/${mod.id}`, {
      allow: permissionsToString(PERM.MANAGE_MESSAGES),
      deny: "0",
    });
    expect(grant.status).toBe(403);
    const higher = await api(ann.token).put(`/channels/${general.id}/overwrites/role/${admin.id}`, {
      allow: "0",
      deny: "0",
    });
    expect(higher.status).toBe(403);
  });
});

describe("channels", () => {
  it("creates, edits, reorders and deletes channels and categories, pushing events", async () => {
    const { sock } = await identified(owner);
    const category = (await api(owner).post("/categories", { name: "Games" })).body;
    expect((await sock.next((f) => f.t === "CATEGORY_CREATE")).d).toMatchObject({
      category: { name: "Games" },
    });

    const created = await api(owner).post("/channels", {
      type: "text",
      name: "Big Chat",
      categoryId: category.id,
      topic: "hello",
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("big-chat"); // text channel names are normalised
    await sock.next((f) => f.t === "CHANNEL_CREATE");

    const voice = await api(owner).post("/channels", { type: "voice", name: "Game Night" });
    expect(voice.body.name).toBe("Game Night");

    const renamed = await api(owner).patch(`/channels/${created.body.id}`, {
      name: "Chat",
      settings: { slowmodeSecs: 5 },
    });
    expect(renamed.body).toMatchObject({ name: "chat", settings: { slowmodeSecs: 5 } });
    await sock.next((f) => f.t === "CHANNEL_UPDATE");

    expect(
      (
        await api(owner).patch("/channels/reorder", {
          items: [{ id: created.body.id, categoryId: category.id, position: 3 }],
        })
      ).status,
    ).toBe(204);
    await sock.next((f) => f.t === "CHANNEL_REORDER");

    expect((await api(owner).del(`/channels/${created.body.id}`)).status).toBe(204);
    expect((await sock.next((f) => f.t === "CHANNEL_DELETE")).d).toMatchObject({
      channelId: created.body.id,
    });
    expect((await api(owner).del(`/categories/${category.id}`)).status).toBe(204);
    expect(
      (await api(owner).get("/channels")).body.channels.map((c: { name: string }) => c.name),
    ).not.toContain("chat");
    sock.close();
  });

  it("archives a channel: hidden from members, still listed for managers", async () => {
    const ann = await s.register("ann");
    const ch = (await api(owner).post("/channels", { type: "text", name: "old" })).body;
    await api(owner).patch(`/channels/${ch.id}`, { archived: true });
    expect((await api(ann.token).get("/channels")).body.channels.map((c: any) => c.name)).not.toContain(
      "old",
    );
    expect((await api(owner).get("/channels?archived=true")).body.channels.map((c: any) => c.name)).toEqual([
      "old",
    ]);
    await api(owner).patch(`/channels/${ch.id}`, { archived: false });
    expect((await api(ann.token).get("/channels")).body.channels.map((c: any) => c.name)).toContain("old");
  });

  it("answers 404 for unknown channels and validates input", async () => {
    expect((await api(owner).patch("/channels/nope", { name: "x" })).status).toBe(404);
    expect((await api(owner).post("/channels", { type: "dm", name: "x" })).status).toBe(400);
    expect((await api(owner).post("/channels", { type: "text", name: "  " })).status).toBe(400);
  });
});

describe("timeouts", () => {
  it("strip sending but keep reading", async () => {
    const ann = await s.register("ann");
    const rolesApi = s.running.apis.get<RolesApi>("roles")!;
    const { channels } = (await api(ann.token).get("/channels")).body as {
      channels: { id: string; name: string }[];
    };
    const general = channels.find((c) => c.name === "general")!;
    const { sock } = await identified(ann.token);
    expect(await rolesApi.can(ann.id, "SEND_MESSAGES", general.id)).toBe(true);
    await rolesApi.setTimeout(ann.id, Date.now() + 60_000);
    expect(await rolesApi.can(ann.id, "SEND_MESSAGES", general.id)).toBe(false);
    expect(await rolesApi.can(ann.id, "VIEW_CHANNEL", general.id)).toBe(true);
    const update = await sock.next((f) => f.t === "PERMISSIONS_UPDATE");
    expect((BigInt((update.d as any).channels[general.id]) & PERM.SEND_MESSAGES) === 0n).toBe(true);
    await rolesApi.setTimeout(ann.id, null);
    expect(await rolesApi.can(ann.id, "SEND_MESSAGES", general.id)).toBe(true);
    sock.close();
  });
});
