// SPDX-License-Identifier: AGPL-3.0-or-later
import sharp from "sharp";
import { Op, PERM, permissionsToString } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer, type TestUser } from "../../testing/harness.js";

let s: TestServer;
let owner: string;
let ann: TestUser;
let bo: TestUser;
let general: string;
let png: Buffer;

const call = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
  put: (path: string, body?: unknown) => s.request("PUT", `/api/v1${path}`, { token, body }),
  patch: (path: string, body?: unknown) => s.request("PATCH", `/api/v1${path}`, { token, body }),
  del: (path: string) => s.request("DELETE", `/api/v1${path}`, { token }),
});

const form = (bytes: Buffer | string, filename: string, type: string) => {
  const f = new FormData();
  f.set("file", new Blob([bytes], { type }), filename);
  return f;
};
const upload = (token: string, bytes: Buffer | string, filename: string, type: string) =>
  s.request("POST", "/api/v1/uploads", { token, form: form(bytes, filename, type) });

async function start(uploads: Record<string, unknown> = {}) {
  s = await startTestServer({
    config: {
      modules: {
        accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
        uploads,
      },
    },
  });
  owner = await s.setupOwner();
  ann = await s.register("ann");
  bo = await s.register("bo");
  general = (await call(owner).get("/channels")).body.channels.find((c: any) => c.name === "general").id;
}

beforeEach(async () => {
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#cc3333" } })
    .png()
    .toBuffer();
  await start();
});
afterEach(async () => {
  await s.close();
});

const say = (token: string, content: string, attachmentIds: string[] = []) =>
  call(token).post(`/channels/${general}/messages`, { content, attachmentIds });

describe("uploading", () => {
  it("stores an image with its size and a thumbnail, and serves both safely", async () => {
    const res = await upload(ann.token, png, "red.png", "image/png");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      filename: "red.png",
      contentType: "image/png",
      width: 40,
      height: 30,
      hasThumbnail: true,
    });

    const file = await s.request("GET", `/api/v1/files/${res.body.id}/red.png`, { token: ann.token });
    expect(file.status).toBe(200);
    expect(file.bytes.equals(png)).toBe(true);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(file.headers.get("content-security-policy")).toContain("sandbox");

    const thumb = await s.request("GET", `/api/v1/files/${res.body.id}/red.png?thumb=1`, {
      token: ann.token,
    });
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    expect((await sharp(thumb.bytes).metadata()).format).toBe("webp");
  });

  it("serves other files as downloads and never trusts the declared type", async () => {
    const txt = await upload(ann.token, "hello", "notes.txt", "text/plain");
    expect(txt.body).toMatchObject({ contentType: "text/plain", width: null, hasThumbnail: false });
    const f1 = await s.request("GET", `/api/v1/files/${txt.body.id}/notes.txt`, { token: ann.token });
    expect(f1.headers.get("content-disposition")).toMatch(/^attachment;/);

    const html = await upload(ann.token, "<script>alert(1)</script>", "x.html", "text/html");
    expect(html.body.contentType).toBe("application/octet-stream");
    const svg = await upload(ann.token, "<svg onload=alert(1)/>", "x.svg", "image/svg+xml");
    expect(svg.body.contentType).toBe("application/octet-stream");
    const disguised = await upload(ann.token, "<html>", "cat.png", "image/png");
    expect(disguised.body.contentType).toBe("application/octet-stream");
    const f2 = await s.request("GET", `/api/v1/files/${disguised.body.id}/cat.png`, { token: ann.token });
    expect(f2.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("refuses an undecodable image, an empty file, a non-multipart body and too large files", async () => {
    const bad = Buffer.concat([png.subarray(0, 8), Buffer.from("garbage")]);
    expect((await upload(ann.token, bad, "bad.png", "image/png")).status).toBe(415);
    expect((await upload(ann.token, "", "empty.txt", "text/plain")).status).toBe(400);
    expect((await s.request("POST", "/api/v1/uploads", { token: ann.token, body: { a: 1 } })).status).toBe(
      415,
    );
    await s.close();
    await start({ maxBytes: 2048 });
    const big = await upload(ann.token, Buffer.alloc(4096, 1), "big.bin", "application/octet-stream");
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("cleans file names", async () => {
    const r = await upload(ann.token, "x", "../../etc/pass<>wd.txt", "text/plain");
    expect(r.body.filename).toBe("passwd.txt");
    const unicode = await upload(ann.token, "x", "répertoire ✓.txt", "text/plain");
    expect(unicode.body.filename).toBe("répertoire ✓.txt");
    const f = await s.request("GET", `/api/v1/files/${unicode.body.id}/x`, { token: ann.token });
    expect(f.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''r%C3%A9pertoire%20%E2%9C%93.txt",
    );
  });

  it("needs a login and ATTACH_FILES", async () => {
    expect(
      (await s.request("POST", "/api/v1/uploads", { form: form("x", "a.txt", "text/plain") })).status,
    ).toBe(401);
    const everyone = ((await call(owner).get("/roles")).body as any[]).find((r) => r.isDefault);
    const allowed = permissionsToString(BigInt(everyone.permissions) & ~PERM.ATTACH_FILES);
    await s.request("PATCH", `/api/v1/roles/${everyone.id}`, {
      token: owner,
      body: { permissions: allowed },
    });
    const denied = await upload(ann.token, "x", "a.txt", "text/plain");
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.missing).toBe("ATTACH_FILES");
  });
});

describe("quota", () => {
  it("counts non-deleted uploads against the quota and frees it on delete", async () => {
    await s.close();
    await start({ userQuotaBytes: 3000 });
    const a = await upload(ann.token, Buffer.alloc(2000, 1), "a.bin", "application/octet-stream");
    expect(a.status).toBe(201);
    expect((await call(ann.token).get("/users/@me/storage")).body).toEqual({
      usedBytes: 2000,
      quotaBytes: 3000,
    });
    const over = await upload(ann.token, Buffer.alloc(2000, 2), "b.bin", "application/octet-stream");
    expect(over.status).toBe(413);
    expect(over.body.error.code).toBe("QUOTA_EXCEEDED");
    expect((await call(bo.token).get("/users/@me/storage")).body.usedBytes).toBe(0); // per user
    expect((await call(ann.token).del(`/uploads/${a.body.id}`)).status).toBe(204);
    expect((await call(ann.token).get("/users/@me/storage")).body.usedBytes).toBe(0);
    expect((await upload(ann.token, Buffer.alloc(2000, 2), "b.bin", "application/octet-stream")).status).toBe(
      201,
    );
    expect((await call(bo.token).del(`/uploads/${a.body.id}`)).status).toBe(404);
  });
});

describe("attaching to messages", () => {
  it("attaches own, unused uploads and refuses anyone else's", async () => {
    const mine = (await upload(ann.token, png, "red.png", "image/png")).body;
    const theirs = (await upload(bo.token, png, "bo.png", "image/png")).body;
    expect((await say(ann.token, "stolen", [theirs.id])).status).toBe(400);
    const sent = await say(ann.token, "look", [mine.id]);
    expect(sent.status).toBe(201);
    expect(sent.body.attachments).toEqual([
      {
        id: mine.id,
        filename: "red.png",
        contentType: "image/png",
        size: png.length,
        width: 40,
        height: 30,
        hasThumbnail: true,
        removed: false,
      },
    ]);
    // An upload serves one message.
    expect((await say(ann.token, "again", [mine.id])).status).toBe(400);
    // A file alone is a message.
    const solo = (await upload(ann.token, "x", "x.txt", "text/plain")).body;
    expect((await say(ann.token, "", [solo.id])).status).toBe(201);
    expect((await say(ann.token, "", [])).status).toBe(400);
  });

  it("limits file access to the uploader until attached, then to those who can see the channel", async () => {
    const up = (await upload(ann.token, png, "red.png", "image/png")).body;
    const url = `/api/v1/files/${up.id}/red.png`;
    expect((await s.request("GET", url, { token: bo.token })).status).toBe(404);
    await say(ann.token, "here", [up.id]);
    expect((await s.request("GET", url, { token: bo.token })).status).toBe(200);
    expect((await s.request("GET", url)).status).toBe(401);
    const everyone = ((await call(owner).get("/roles")).body as any[]).find((r) => r.isDefault);
    await call(owner).put(`/channels/${general}/overwrites/role/${everyone.id}`, {
      allow: "0",
      deny: permissionsToString(PERM.VIEW_CHANNEL),
    });
    expect((await s.request("GET", url, { token: bo.token })).status).toBe(404);
    expect((await s.request("GET", url, { token: owner })).status).toBe(200);
  });

  it("needs ATTACH_FILES in the channel", async () => {
    const up = (await upload(ann.token, png, "red.png", "image/png")).body;
    const everyone = ((await call(owner).get("/roles")).body as any[]).find((r) => r.isDefault);
    await call(owner).put(`/channels/${general}/overwrites/role/${everyone.id}`, {
      allow: "0",
      deny: permissionsToString(PERM.ATTACH_FILES),
    });
    const denied = await say(ann.token, "x", [up.id]);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.missing).toBe("ATTACH_FILES");
    expect((await say(ann.token, "just text")).status).toBe(201);
  });

  it("shows 'File removed' to everyone when the uploader deletes the file", async () => {
    const up = (await upload(ann.token, png, "red.png", "image/png")).body;
    const msg = (await say(ann.token, "pic", [up.id])).body;
    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: bo.token, client: { name: "t", version: "1", platform: "node" } },
    });
    await sock.next((f) => f.t === "READY");
    expect((await call(ann.token).del(`/uploads/${up.id}`)).status).toBe(204);
    const update = await sock.next((f) => f.t === "MESSAGE_UPDATE");
    expect((update.d as any).message.attachments[0]).toMatchObject({
      id: up.id,
      removed: true,
      filename: "",
    });
    expect((await s.request("GET", `/api/v1/files/${up.id}/red.png`, { token: bo.token })).status).toBe(404);
    const listed = (await call(bo.token).get(`/channels/${general}/messages`)).body;
    expect(listed.find((m: any) => m.id === msg.id).attachments[0].removed).toBe(true);
    sock.close();
  });

  it("removes a deleted message's files", async () => {
    const up = (await upload(ann.token, png, "red.png", "image/png")).body;
    const msg = (await say(ann.token, "pic", [up.id])).body;
    await call(ann.token).del(`/channels/${general}/messages/${msg.id}`);
    await s.running.events.idle();
    expect((await s.request("GET", `/api/v1/files/${up.id}/red.png`, { token: ann.token })).status).toBe(404);
    expect((await call(ann.token).get("/users/@me/storage")).body.usedBytes).toBe(0);
  });
});

describe("own attachments (U16)", () => {
  it("lists by date or size with cursors, and shows where only for channels still visible", async () => {
    const sizes = [300, 100, 200];
    const ids: string[] = [];
    for (const n of sizes)
      ids.push(
        (await upload(ann.token, Buffer.alloc(n, 1), `f${n}.bin`, "application/octet-stream")).body.id,
      );
    await say(ann.token, "attached", [ids[0]!]);

    const bySize = await call(ann.token).get("/users/@me/attachments?sort=size&limit=2");
    expect(bySize.body.items.map((i: any) => i.size)).toEqual([300, 200]);
    expect(bySize.body.items[0]).toMatchObject({ channelId: general, messageId: expect.any(String) });
    const rest = await call(ann.token).get(
      `/users/@me/attachments?sort=size&limit=2&cursor=${encodeURIComponent(bySize.body.nextCursor)}`,
    );
    expect(rest.body.items.map((i: any) => i.size)).toEqual([100]);
    expect(rest.body.nextCursor).toBeNull();

    const byDate = await call(ann.token).get("/users/@me/attachments?sort=date");
    expect(byDate.body.items.map((i: any) => i.size)).toEqual([200, 100, 300]);

    const everyone = ((await call(owner).get("/roles")).body as any[]).find((r) => r.isDefault);
    await call(owner).put(`/channels/${general}/overwrites/role/${everyone.id}`, {
      allow: "0",
      deny: permissionsToString(PERM.VIEW_CHANNEL),
    });
    const hidden = await call(ann.token).get("/users/@me/attachments?sort=size");
    expect(hidden.body.items[0]).toMatchObject({ size: 300, channelId: null, messageId: null });
    expect((await call(bo.token).get("/users/@me/attachments")).body.items).toEqual([]);
  });
});

describe("avatars", () => {
  it("resizes to a square webp, serves it, announces it and replaces the old one", async () => {
    const sock = s.connect();
    await sock.next();
    sock.send({
      op: Op.IDENTIFY,
      d: { token: bo.token, client: { name: "t", version: "1", platform: "node" } },
    });
    await sock.next((f) => f.t === "READY");
    const wide = await sharp({ create: { width: 600, height: 200, channels: 3, background: "#3366cc" } })
      .png()
      .toBuffer();
    const res = await s.request("PUT", "/api/v1/users/@me/avatar", {
      token: ann.token,
      form: form(wide, "me.png", "image/png"),
    });
    expect(res.status).toBe(200);
    expect(res.body.avatarKey).toMatch(/^[0-9A-Z]{26}-[0-9a-f]{12}\.webp$/);
    expect((await sock.next((f) => f.t === "USER_UPDATE")).d).toMatchObject({
      id: ann.id,
      avatarKey: res.body.avatarKey,
    });
    const img = await s.request("GET", `/api/v1/avatars/${res.body.avatarKey}`, { token: bo.token });
    const meta = await sharp(img.bytes).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([256, 256, "webp"]);
    expect(img.headers.get("cache-control")).toContain("immutable");
    expect((await s.request("GET", `/api/v1/avatars/${res.body.avatarKey}`)).status).toBe(401);

    const second = await s.request("PUT", "/api/v1/users/@me/avatar", {
      token: ann.token,
      form: form(png, "me2.png", "image/png"),
    });
    expect(second.body.avatarKey).not.toBe(res.body.avatarKey);
    expect(
      (await s.request("GET", `/api/v1/avatars/${res.body.avatarKey}`, { token: bo.token })).status,
    ).toBe(404);
    expect((await call(ann.token).del("/users/@me/avatar")).status).toBe(204);
    expect((await call(ann.token).get("/users/@me")).body.avatarKey).toBeNull();
    expect(
      (
        await s.request("PUT", "/api/v1/users/@me/avatar", {
          token: ann.token,
          form: form("nope", "x.png", "image/png"),
        })
      ).status,
    ).toBe(415);
    sock.close();
  });
});

describe("orphan GC", () => {
  it("removes uploads that never got a message after a day, and keeps fresh and attached ones", async () => {
    const stale = (await upload(ann.token, png, "stale.png", "image/png")).body;
    const fresh = (await upload(ann.token, png, "fresh.png", "image/png")).body;
    const attached = (await upload(ann.token, png, "att.png", "image/png")).body;
    await say(ann.token, "x", [attached.id]);
    await s.running.ports.db.query
      .updateTable("attachment" as never)
      .set({ created_at: Date.now() - 2 * 86_400_000 } as never)
      .where("id" as never, "in", [stale.id, attached.id] as never)
      .execute();
    await s.running.scheduler.runNow("uploads.gc");
    expect((await s.request("GET", `/api/v1/files/${stale.id}/x`, { token: ann.token })).status).toBe(404);
    expect((await s.request("GET", `/api/v1/files/${fresh.id}/x`, { token: ann.token })).status).toBe(200);
    expect((await s.request("GET", `/api/v1/files/${attached.id}/x`, { token: ann.token })).status).toBe(200);
  });
});

describe("module off", () => {
  it("is gone, and messages reject attachments", async () => {
    await s.close();
    s = await startTestServer({ config: { modules: { uploads: { enabled: false } } } });
    const token = await s.setupOwner();
    expect((await s.request("POST", "/api/v1/uploads", { token })).status).toBe(404);
    const ch = (await s.request("GET", "/api/v1/channels", { token })).body.channels[0].id;
    const r = await s.request("POST", `/api/v1/channels/${ch}/messages`, {
      token,
      body: { content: "x", attachmentIds: ["a".repeat(26)] },
    });
    expect(r.body.error.code).toBe("FEATURE_DISABLED");
  });

  it("lets the owner change the file size and quota limits at runtime, without a restart", async () => {
    const big = Buffer.alloc(40 * 1024, 1);
    expect((await upload(ann.token, big, "big.bin", "application/octet-stream")).status).toBe(201);

    const lowered = await call(owner).patch("/admin/uploads", { maxBytes: 8192 });
    expect(lowered.status).toBe(200);
    expect(lowered.body.maxBytes).toBe(8192);
    expect((await upload(ann.token, big, "big2.bin", "application/octet-stream")).status).toBe(413);
    const caps = (await s.request("GET", "/api/v1/capabilities")).body;
    expect(caps.features.uploads.maxBytes).toBe(8192);
    expect(caps.limits.uploadMaxBytes).toBe(8192);

    // Raise the file limit again; a 40 KiB file now fits, a second one does not fit the 50 KiB quota.
    await call(owner).patch("/admin/uploads", { maxBytes: 64 * 1024, userQuotaBytes: 50 * 1024 });
    const used = await call(ann.token).get("/users/@me/storage");
    expect(used.body.quotaBytes).toBe(50 * 1024);
    const again = await upload(ann.token, big, "again.bin", "application/octet-stream");
    expect(again.status).toBe(413);
    expect(again.body.error.code).toBe("QUOTA_EXCEEDED");
  });

  it("only the owner may read or change the limits, and the ceiling holds", async () => {
    expect((await call(ann.token).get("/admin/uploads")).status).toBe(403);
    expect((await call(ann.token).patch("/admin/uploads", { maxBytes: 4096 })).status).toBe(403);
    const read = await call(owner).get("/admin/uploads");
    expect(read.status).toBe(200);
    expect(read.body.ceilingBytes).toBe(512 * 1024 * 1024);
    expect((await call(owner).patch("/admin/uploads", { maxBytes: 513 * 1024 * 1024 })).status).toBe(400);
    expect((await call(owner).patch("/admin/uploads", {})).status).toBe(400);
    expect((await call(owner).patch("/admin/uploads", { maxBytes: 10 })).status).toBe(400);
  });
});
