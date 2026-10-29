// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "@tincan/db";
import { PERM, permissionsToString } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer, type TestUser } from "../../testing/harness.js";
import type { SearchApi } from "./api.js";
import { ftsTerms, matchExpression } from "./service.js";

let s: TestServer;
let owner: string;
let ann: TestUser;
let bo: TestUser;
let general: string;
let secret: string;
let everyone: string;

const call = (token: string) => ({
  get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
  post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
  put: (path: string, body?: unknown) => s.request("PUT", `/api/v1${path}`, { token, body }),
  patch: (path: string, body?: unknown) => s.request("PATCH", `/api/v1${path}`, { token, body }),
  del: (path: string) => s.request("DELETE", `/api/v1${path}`, { token }),
});

const say = async (user: TestUser | { token: string; id: string }, channel: string, content: string) => {
  await s.running.ports.pubsub.kv.del(`rl:msg:${user.id}:${channel}`);
  return (await call(user.token).post(`/channels/${channel}/messages`, { content })).body.id as string;
};
const settle = () => s.running.outbox.drain();
const find = async (token: string, query: string) => {
  await settle();
  return call(token).get(`/search?q=${encodeURIComponent(query)}`);
};
const texts = (r: { body: { items: { content: string }[] } }) => r.body.items.map((m) => m.content);

beforeEach(async () => {
  s = await startTestServer();
  owner = await s.setupOwner();
  ann = await s.register("ann");
  bo = await s.register("bo");
  const channels = (await call(owner).get("/channels")).body.channels as { id: string; name: string }[];
  general = channels.find((c) => c.name === "general")!.id;
  secret = (await call(owner).post("/channels", { type: "text", name: "secret" })).body.id;
  everyone = ((await call(owner).get("/roles")).body as any[]).find((r) => r.isDefault).id;
});
afterEach(async () => {
  await s.close();
});

describe("query building", () => {
  it("quotes every word, makes only the last a long prefix, and cannot be injected into", () => {
    expect(ftsTerms("hello wor")).toEqual(['"hello"', '"wor"*']);
    expect(ftsTerms("hello wo")).toEqual(['"hello"', '"wo"']);
    expect(ftsTerms('"; DROP TABLE x -- OR NOT NEAR(a b) chan:abc')).toEqual(
      ['"drop"', '"table"', '"or"', '"not"', '"near"', '"chan"', '"abc"*'].slice(0, 8),
    );
    expect(ftsTerms("a b")).toEqual([]);
    expect(ftsTerms("naïve café")).toEqual(['"naïve"', '"café"*']);
    expect(matchExpression(['"a"'], ["C1", "C2"], "U1")).toBe(
      'content : ("a") AND chan : ("C1" OR "C2") AND author : ("U1")',
    );
  });
});

describe("search", () => {
  it("finds messages newest first, with prefixes, and the message objects hydrated", async () => {
    await say(ann, general, "the quick brown fox");
    await say(bo, general, "a quick lunch");
    await say(ann, general, "nothing here");
    const r = await find(bo.token, "quick");
    expect(texts(r)).toEqual(["a quick lunch", "the quick brown fox"]);
    expect(r.body.items[0]).toMatchObject({ channelId: general, author: { username: "bo" } });
    expect(texts(await find(bo.token, "quic"))).toHaveLength(2); // prefix of 4 letters
    expect(texts(await find(bo.token, "brown fox"))).toEqual(["the quick brown fox"]); // both terms
    expect(texts(await find(bo.token, "QUICK"))).toHaveLength(2); // case-insensitive
    expect(texts(await find(bo.token, "zzzz"))).toEqual([]);
  });

  it("follows edits and deletes", async () => {
    const m = await say(ann, general, "alpha beta");
    expect(texts(await find(bo.token, "alpha"))).toEqual(["alpha beta"]);
    await call(ann.token).patch(`/channels/${general}/messages/${m}`, { content: "gamma delta" });
    expect(texts(await find(bo.token, "alpha"))).toEqual([]);
    expect(texts(await find(bo.token, "gamma"))).toEqual(["gamma delta"]);
    await call(ann.token).del(`/channels/${general}/messages/${m}`);
    expect(texts(await find(bo.token, "gamma"))).toEqual([]);
  });

  it("filters by channel and author", async () => {
    await say(ann, general, "report one");
    await say(owner === ann.token ? ann : { token: owner, id: "x" }, secret, "report two");
    await say(bo, general, "report three");
    const byAuthor = await call(bo.token).get(`/search?q=report&authorId=${ann.id}`);
    expect(texts(byAuthor)).toEqual(["report one"]);
    const byChannel = await call(owner).get(`/search?q=report&channelId=${secret}`);
    expect(texts(byChannel)).toEqual(["report two"]);
    expect(texts(await call(owner).get(`/search?q=report`))).toHaveLength(3);
  });

  it("only ever returns what the member can read now, whatever was visible when it was indexed", async () => {
    await say(
      { token: owner, id: (await call(owner).get("/members")).body.items[0].userId },
      secret,
      "launch codes",
    );
    await say(ann, general, "launch party");
    await call(owner).put(`/channels/${secret}/overwrites/role/${everyone}`, {
      allow: "0",
      deny: permissionsToString(PERM.VIEW_CHANNEL),
    });
    expect(texts(await find(bo.token, "launch"))).toEqual(["launch party"]);
    expect(texts(await find(owner, "launch"))).toHaveLength(2);
    // Asking for the hidden channel by ID looks like a channel with no hits, not an error.
    const direct = await call(bo.token).get(`/search?q=launch&channelId=${secret}`);
    expect(direct.status).toBe(200);
    expect(direct.body.items).toEqual([]);
    // Visible again, but without READ_HISTORY: still nothing from it.
    await call(owner).put(`/channels/${secret}/overwrites/role/${everyone}`, {
      allow: "0",
      deny: permissionsToString(PERM.READ_HISTORY),
    });
    expect(texts(await find(bo.token, "launch"))).toEqual(["launch party"]);
    await call(owner).del(`/channels/${secret}/overwrites/role/${everyone}`);
    expect(texts(await find(bo.token, "launch"))).toHaveLength(2);
  });

  it("pages with a cursor, newest first, without repeats or gaps", async () => {
    for (let i = 0; i < 7; i++) await say(ann, general, `needle ${i}`);
    await settle();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await call(bo.token).get(`/search?q=needle&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...texts(r));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0].map((i) => `needle ${i}`));
  });

  it("ranks by relevance within the newest matches when asked", async () => {
    await say(ann, general, "rust rust rust rust crab");
    await say(ann, general, "crab and some other words here for length");
    await say(ann, general, "crab");
    await settle();
    const r = await call(bo.token).get("/search?q=crab&sort=relevance");
    expect(texts(r)[0]).toBe("crab");
    expect(texts(r)).toHaveLength(3);
    const page = await call(bo.token).get("/search?q=crab&sort=relevance&limit=2");
    expect(page.body.nextCursor).toBe("2");
    expect(texts(await call(bo.token).get("/search?q=crab&sort=relevance&limit=2&cursor=2"))).toHaveLength(1);
  });

  it("validates the query and rate limits", async () => {
    expect((await call(bo.token).get("/search?q=a")).status).toBe(400);
    expect((await call(bo.token).get("/search")).status).toBe(400);
    expect((await call(bo.token).get("/search?q=!!!")).body.items).toEqual([]);
    expect((await s.request("GET", "/api/v1/search?q=hello")).status).toBe(401);
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await call(bo.token).get("/search?q=hello")).status;
    expect(last).toBe(429);
  });

  it("handles quotes, operators and odd input as plain words", async () => {
    await say(ann, general, 'she said "hello" OR NOT goodbye');
    expect(texts(await find(bo.token, 'hello" OR "x'))).toEqual(['she said "hello" OR NOT goodbye']);
    expect((await call(bo.token).get(`/search?q=${encodeURIComponent("NEAR(")}`)).status).toBe(200);
    expect((await call(bo.token).get(`/search?q=${encodeURIComponent("chan:x*")}`)).status).toBe(200);
  });
});

describe("the index follows the outbox (18 T29)", () => {
  it("is idempotent when a row is delivered twice", async () => {
    const m = await say(ann, general, "twice indexed");
    await settle();
    // Redeliver: replay the same upsert straight through the outbox handler.
    await s.running.ports.db.transaction(async (tx) => {
      await s.running.outbox.append(tx, "search.message", {
        op: "upsert",
        id: m,
        channelId: general,
        authorId: ann.id,
        text: "twice indexed",
      });
    });
    await settle();
    const rows = await sql<{
      n: number;
    }>`SELECT count(*) AS n FROM search_doc WHERE message_id = ${m}`.execute(s.running.ports.db.query);
    expect(rows.rows[0]!.n).toBe(1);
    expect(texts(await find(bo.token, "twice"))).toHaveLength(1);
  });

  it("catches up on rows queued but not yet delivered, as after a crash between commit and indexing", async () => {
    // Stop delivery, send, then "crash": the row is durable in the outbox and nothing was indexed.
    s.running.outbox.close();
    await say(ann, general, "queued before the crash");
    expect(await s.running.outbox.backlog()).toBeGreaterThan(0);
    await s.running.close();

    // A fresh process on the same data finds the row and indexes it.
    const second = await startTestServer({
      config: {
        dataDir: s.dir,
        adapters: {
          database: { kind: "sqlite", path: `${s.dir}/app.db` },
          storage: { kind: "local", path: `${s.dir}/files` },
        },
      },
    });
    try {
      await second.running.outbox.drain();
      const token = (await second.login("ann", "correct horse battery staple")).body.token;
      const r = await second.request("GET", "/api/v1/search?q=crash", { token });
      expect(r.body.items.map((m: { content: string }) => m.content)).toEqual(["queued before the crash"]);
      expect(await second.running.outbox.backlog()).toBe(0);
    } finally {
      await second.running.close();
    }
  });

  it("keeps working with no search results leaking when the module is off", async () => {
    await s.close();
    s = await startTestServer({ config: { modules: { search: { enabled: false } } } });
    owner = await s.setupOwner();
    expect((await call(owner).get("/search?q=hello")).status).toBe(404);
    // text-chat does not write outbox rows nobody consumes
    const ch = (await call(owner).get("/channels")).body.channels[0].id;
    await call(owner).post(`/channels/${ch}/messages`, { content: "hello" });
    expect(await s.running.outbox.backlog()).toBe(0);
  });
});

describe("reindex", () => {
  const reindex = async () => {
    const api = s.running.apis.get<SearchApi>("search")!;
    const r = await api.reindex({ batchSize: 2 });
    await s.running.outbox.drain();
    return r;
  };

  it("rebuilds a wiped index, and drops entries for messages that are gone", async () => {
    const ids = [
      await say(ann, general, "one fish"),
      await say(ann, general, "two fish"),
      await say(ann, general, "red fish"),
    ];
    await settle();
    expect(texts(await find(bo.token, "fish"))).toHaveLength(3);

    const db = s.running.ports.db.query;
    await sql`DELETE FROM message_fts`.execute(db);
    await sql`DELETE FROM search_doc`.execute(db);
    expect(texts(await find(bo.token, "fish"))).toEqual([]);

    // A message deleted behind the index's back, and an entry for one that never existed.
    await sql`UPDATE message SET deleted_at = 1 WHERE id = ${ids[1]!}`.execute(db);
    await sql`INSERT INTO message_fts (content, chan, author, message_id) VALUES ('ghost fish', ${general}, ${ann.id}, 'GHOST')`.execute(
      db,
    );
    await sql`INSERT INTO search_doc (fts_rowid, message_id) VALUES (last_insert_rowid(), 'GHOST')`.execute(
      db,
    );

    const result = await reindex();
    expect(result).toEqual({ queued: 2, removed: 1 });
    expect(texts(await find(bo.token, "fish")).sort()).toEqual(["one fish", "red fish"]);
  });

  it("is safe to run on a healthy index and while messages keep arriving", async () => {
    await say(ann, general, "steady state");
    await settle();
    const r1 = await reindex();
    expect(r1).toEqual({ queued: 1, removed: 0 });
    const during = say(ann, general, "arrived during");
    const r2 = reindex();
    await Promise.all([during, r2]);
    await settle();
    expect(texts(await find(bo.token, "steady"))).toHaveLength(1);
    expect(texts(await find(bo.token, "arrived"))).toHaveLength(1);
    const count = await sql<{ n: number }>`SELECT count(*) AS n FROM search_doc`.execute(
      s.running.ports.db.query,
    );
    expect(count.rows[0]!.n).toBe(2);
  });
});
