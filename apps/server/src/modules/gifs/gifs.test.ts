// SPDX-License-Identifier: AGPL-3.0-or-later
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchNetwork } from "../../net/fetcher.js";
import { startTestServer, type TestServer, type TestUser } from "../../testing/harness.js";
import type { GifsServiceApi } from "./api.js";
import { giphy, tenor } from "./providers.js";

/**
 * The provider APIs and their media hosts are all faked by one local HTTP server; the service
 * only ever sees URLs it built itself (`setOrigins`) or the provider returned (media hosts).
 */

// A real (tiny) animated GIF: sharp must be able to take the first frame for the "still" variant.
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

describe("provider adapters", () => {
  it("build Tenor v2 requests and normalise the answers", () => {
    const url = tenor.searchUrl("https://api.test", "KEY", "a cat", "p1", 24, "medium");
    expect(url).toBe(
      "https://api.test/v2/search?key=KEY&client_key=tincan&q=a%20cat&limit=24&media_filter=gif,tinygif,mediumgif&contentfilter=medium&pos=p1",
    );
    const page = tenor.parsePage({
      results: [
        {
          id: "42",
          content_description: "cat dance",
          media_formats: {
            tinygif: { url: "https://media.tenor.com/t.gif", dims: [220, 123], size: 9 },
            gif: { url: "https://media.tenor.com/g.gif", dims: [498, 280], size: 99 },
          },
        },
        { id: "43", content_description: "no formats" },
      ],
      next: "p2",
    });
    expect(page.next).toBe("p2");
    expect(page.posts).toHaveLength(1);
    expect(page.posts[0]).toMatchObject({ id: "42", title: "cat dance" });
    expect(page.posts[0]!.renditions.gif).toMatchObject({ width: 498, height: 280 });
  });

  it("build GIPHY v1 requests, maps the rating and derives an offset cursor", () => {
    const url = giphy.searchUrl("https://api.test", "KEY", "hi", "0", 24, "high");
    expect(url).toContain("rating=g");
    expect(url).toContain("offset=0");
    expect(giphy.searchUrl("https://api.test", "KEY", "hi", "0", 24, "off")).toContain("rating=r");
    const page = giphy.parsePage({
      data: [
        {
          id: "g1",
          title: "wave",
          images: {
            fixed_width: { url: "https://media.giphy.com/m.gif", width: "200", height: "112" },
            original: { url: "https://media.giphy.com/o.gif", width: "400", height: "224" },
          },
        },
      ],
      pagination: { offset: 0, count: 1, total_count: 2 },
    });
    expect(page.next).toBe("1");
    expect(page.posts[0]!.renditions.original).toMatchObject({ width: 400, height: 224 });
    expect(giphy.parsePage({ data: [], pagination: { offset: 24, count: 24, total_count: 24 } }).next).toBe(
      "",
    );
  });
});

describe("gifs module", () => {
  let s: TestServer;
  let owner: string;
  let ann: TestUser;
  let general: string;
  let upstream: http.Server;
  let port: number;
  const hits = new Map<string, number>();
  const hit = (req: http.IncomingMessage) => {
    const u = new URL(req.url ?? "/", "http://x");
    hits.set(u.pathname, (hits.get(u.pathname) ?? 0) + 1);
  };

  const call = (token: string) => ({
    get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
    post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
  });
  const api = () => s.running.apis.get<GifsServiceApi>("gifs")!;
  const net = (): FetchNetwork => ({
    resolve: async () => ["127.0.0.1"],
    allowAddress: (ip) => ip === "127.0.0.1",
    allowedPorts: new Set([port]),
  });
  const giphyMedia = (name: string) => `http://media.giphy.com:${port}/media/${name}`;

  const tenorPost = (id: string, mediaHost = "media.tenor.com") => ({
    id,
    content_description: `tenor ${id}`,
    media_formats: {
      tinygif: { url: `http://${mediaHost}:${port}/media/${id}-tiny.gif`, dims: [220, 123], size: 900 },
      gif: { url: `http://${mediaHost}:${port}/media/${id}-full.gif`, dims: [498, 280], size: 4000 },
    },
  });

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      hit(req);
      const u = new URL(req.url ?? "/", "http://x");
      const json = (v: unknown) =>
        void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (u.pathname === "/v2/search" || u.pathname === "/v2/featured")
        return json({
          results: [tenorPost("t1"), tenorPost("t2")],
          next: u.searchParams.get("pos") === "p2" ? "" : "p2",
        });
      if (u.pathname === "/v2/posts") {
        const id = u.searchParams.get("ids") ?? "";
        if (id === "t-evil") return json({ results: [tenorPost("t-evil", "not-tenor.example")] });
        return json({ results: id === "t1" || id === "t2" ? [tenorPost(id)] : [] });
      }
      if (u.pathname === "/v1/gifs/search" || u.pathname === "/v1/gifs/trending") {
        const offset = Number(u.searchParams.get("offset") ?? "0");
        return json({
          data:
            offset === 0
              ? [
                  {
                    id: "g1",
                    title: "giphy one",
                    images: {
                      fixed_width_small: {
                        url: giphyMedia("g1-small.gif"),
                        width: "100",
                        height: "56",
                      },
                      fixed_width: { url: giphyMedia("g1-mid.gif"), width: "200", height: "112" },
                      original: { url: giphyMedia("g1-orig.gif"), width: "400", height: "224" },
                    },
                  },
                ]
              : [],
          // total_count 1 once the cursor moved: offset+count >= total means "no more".
          pagination: { offset, count: offset === 0 ? 1 : 0, total_count: offset === 0 ? 2 : 1 },
        });
      }
      if (u.pathname.startsWith("/v1/gifs/"))
        return json(
          u.pathname === "/v1/gifs/g1"
            ? {
                data: {
                  id: "g1",
                  title: "giphy one",
                  images: {
                    fixed_width: { url: giphyMedia("g1-mid.gif"), width: "200", height: "112" },
                    original: { url: giphyMedia("g1-orig.gif"), width: "400", height: "224" },
                  },
                },
              }
            : { data: null, meta: { status: 404 } },
        );
      if (u.pathname.startsWith("/media/"))
        return void res.writeHead(200, { "content-type": "image/gif" }).end(GIF);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    port = (upstream.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => void upstream.close(() => r())));

  const start = async (moduleConfig: Record<string, unknown>) => {
    s = await startTestServer({
      config: {
        modules: {
          accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
          "text-chat": { createRate: { max: 1000, windowSecs: 10 } },
          gifs: { searchCacheSecs: 60, ...moduleConfig },
        },
      },
    });
    api().setNetwork(net());
    api().setOrigins({ tenor: `http://127.0.0.1:${port}`, giphy: `http://127.0.0.1:${port}` });
  };

  beforeEach(async () => {
    hits.clear();
    await start({ tenorKey: "TKEY", giphyKey: "GKEY" });
    owner = await s.setupOwner();
    ann = await s.register("ann");
    general = (await call(owner).get("/channels")).body.channels.find(
      (c: { name: string }) => c.name === "general",
    ).id;
  });
  afterEach(async () => {
    await s.close();
  });

  it("searches Tenor and returns same-origin items plus the provider cursor", async () => {
    const r = await call(ann.token).get("/gifs/search?provider=tenor&q=cat");
    expect(r.status).toBe(200);
    expect(r.body.next).toBe("p2");
    expect(r.body.items).toHaveLength(2);
    const item = r.body.items[0];
    expect(item).toMatchObject({ provider: "tenor", id: "t1", width: 498, height: 280 });
    // Members' browsers only ever see this server's URLs (CSP img-src 'self'): no provider host leaks.
    expect(item.previewUrl).toBe("/api/v1/gifs/media/tenor/t1/preview");
    expect(item.mediaUrl).toBe("/api/v1/gifs/media/tenor/t1/full");
    expect(JSON.stringify(r.body)).not.toMatch(/tenor\.com|giphy\.com|googleapis/);
  });

  it("searches GIPHY and turns pagination into a position cursor", async () => {
    const r = await call(ann.token).get("/gifs/search?provider=giphy&q=dog");
    expect(r.status).toBe(200);
    expect(r.body.next).toBe("1");
    expect(r.body.items[0]).toMatchObject({ provider: "giphy", id: "g1", width: 400, height: 224 });
    const second = await call(ann.token).get("/gifs/search?provider=giphy&q=dog&pos=1");
    expect(second.body.next).toBe("");
  });

  it("serves the trending list for both providers", async () => {
    for (const provider of ["tenor", "giphy"]) {
      const r = await call(ann.token).get(`/gifs/trending?provider=${provider}`);
      expect(r.status, provider).toBe(200);
      expect(r.body.items[0].provider).toBe(provider);
    }
  });

  it("rejects an unknown provider with 400 and needs a member session", async () => {
    expect((await call(ann.token).get("/gifs/search?provider=reddit&q=x")).status).toBe(400);
    expect((await s.request("GET", "/api/v1/gifs/search?provider=tenor&q=x")).status).toBe(401);
  });

  it("answers 400 with a GIF provider reason when that provider has no key", async () => {
    await s.close();
    await start({ tenorKey: "TKEY" });
    const token = await s.setupOwner();
    const r = await call(token).get("/gifs/search?provider=giphy&q=x");
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("GIF_PROVIDER");
    // The capability announces only the configured providers, so the client can hide the rest.
    const caps = await call(token).get("/capabilities");
    expect(caps.body.features.gifs).toEqual({ providers: ["tenor"] });
  });

  it("caches a picker page so the second ask does not call upstream again", async () => {
    const r1 = await call(ann.token).get("/gifs/search?provider=tenor&q=cache");
    expect(hits.get("/v2/search")).toBe(1);
    const r2 = await call(ann.token).get("/gifs/search?provider=tenor&q=cache");
    expect(r2.body).toEqual(r1.body);
    expect(hits.get("/v2/search")).toBe(1);
  });

  it("re-hosts media same-origin, serves it cached the second time", async () => {
    const url = "/gifs/media/tenor/t1/full";
    const first = await call(ann.token).get(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/gif");
    expect(first.bytes.equals(GIF)).toBe(true);
    const mediaHits = hits.get("/media/t1-full.gif") ?? 0;
    const second = await call(ann.token).get(url);
    expect(second.status).toBe(200);
    expect(second.bytes.equals(GIF)).toBe(true);
    expect(hits.get("/media/t1-full.gif")).toBe(mediaHits);
  });

  it("turns the first frame of an animation into a WebP still", async () => {
    const r = await call(ann.token).get("/gifs/media/tenor/t1/still");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    expect(r.bytes.subarray(8, 12).toString()).toBe("WEBP");
  });

  it("answers 404 for media of a post that does not resolve or sits on an unlisted host", async () => {
    expect((await call(ann.token).get("/gifs/media/tenor/missing/full")).status).toBe(404);
    // The provider said the bytes live elsewhere: the server refuses to fetch that host.
    expect((await call(ann.token).get("/gifs/media/tenor/t-evil/full")).status).toBe(404);
    expect(hits.get("/media/t-evil-full.gif")).toBeUndefined();
    // And a badly-formed id cannot even become a storage key.
    expect((await call(ann.token).get("/gifs/media/tenor/..%2F..%2Fetc/full")).status).toBe(400);
  });

  it("sends a GIF-only message, text plus GIF, and rejects a bad id", async () => {
    const only = await call(ann.token).post(`/channels/${general}/messages`, {
      content: "",
      gif: { provider: "tenor", id: "t1" },
    });
    expect(only.status).toBe(201);
    expect(only.body.content).toBe("");
    expect(only.body.gif).toEqual({
      provider: "tenor",
      id: "t1",
      title: "tenor t1",
      width: 498,
      height: 280,
    });

    const both = await call(ann.token).post(`/channels/${general}/messages`, {
      content: "look at this",
      gif: { provider: "tenor", id: "t1" },
    });
    expect(both.status).toBe(201);
    expect(both.body.content).toBe("look at this");
    expect(both.body.gif.id).toBe("t1");

    const bad = await call(ann.token).post(`/channels/${general}/messages`, {
      content: "",
      gif: { provider: "tenor", id: "zzz" },
    });
    expect(bad.status).toBe(400);
    // History hands the GIF back with the message.
    const history = await call(ann.token).get(`/channels/${general}/messages`);
    const found = (history.body as { id: string; gif: { id: string } }[]).find((m) => m.id === only.body.id);
    expect(found?.gif.id).toBe("t1");
  });

  it("still rejects a completely empty message and a GIF that is not set up", async () => {
    const r = await call(ann.token).post(`/channels/${general}/messages`, { content: "" });
    expect(r.status).toBe(400);
    await s.close();
    await start({ tenorKey: "TKEY" });
    const token = await s.setupOwner();
    const channel = (await call(token).get("/channels")).body.channels[0].id;
    const noProvider = await call(token).post(`/channels/${channel}/messages`, {
      content: "",
      gif: { provider: "giphy", id: "g1" },
    });
    expect(noProvider.status).toBe(400);
  });
});
