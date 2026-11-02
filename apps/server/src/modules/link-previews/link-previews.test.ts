// SPDX-License-Identifier: AGPL-3.0-or-later
import http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { extractPreviewUrls } from "@tincan/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer, type TestUser } from "../../testing/harness.js";
import type { LinkPreviewApi } from "./api.js";
import { defaultNetwork, FetchError, safeFetch, type FetchLimits, type FetchNetwork } from "./fetcher.js";
import { ipv6Bytes, isPublicAddress } from "./ip.js";
import { cleanText, decodeEntities, fromMeta, parseHead, plainTextFromHtml } from "./parse.js";
import { domainMatches, providerFor } from "./providers.js";

describe("isPublicAddress", () => {
  it("accepts public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.32.0.1",
      "100.63.255.255",
      "2606:4700::1111",
    ])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
  it("blocks private, loopback, link-local, metadata, CGNAT, reserved and multicast IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "10.255.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "169.254.0.1",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "192.0.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });
  it("blocks IPv6 loopback, unspecified, unique-local, link-local, multicast and documentation", () => {
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "2001:db8::1",
      "2001::1",
      "[::1]",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });
  it("judges wrapped IPv4 addresses by the IPv4 inside", () => {
    for (const ip of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b::a9fe:a9fe",
      "2002:7f00:1::1",
      "2002:a9fe:a9fe::1",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("64:ff9b::808:808")).toBe(true);
  });
  it("rejects what is not an address", () => {
    for (const ip of ["", "localhost", "999.1.1.1", "1.2.3", "example.com"])
      expect(isPublicAddress(ip), ip).toBe(false);
  });
  it("parses IPv6 forms", () => {
    expect(ipv6Bytes("::1")![15]).toBe(1);
    expect(ipv6Bytes("::ffff:1.2.3.4")!.slice(10)).toEqual(Uint8Array.from([0xff, 0xff, 1, 2, 3, 4]));
    expect(ipv6Bytes("1:2:3:4:5:6:7:8")![15]).toBe(8);
    expect(ipv6Bytes("1.2.3.4")).toBeNull();
  });
});

describe("parsing", () => {
  it("decodes entities once and strips tags", () => {
    expect(decodeEntities("Fish &amp; Chips &#8217; &#x41; &bogus; &lt;b&gt;")).toBe(
      "Fish & Chips ’ A &bogus; <b>",
    );
    expect(cleanText("<b>Hi</b>  there &amp;\n you", 50)).toBe("Hi there & you");
  });
  it("removes invisible and bidi characters and caps length", () => {
    expect(cleanText("a‮b​c\u0007d", 10)).toBe("a b c d");
    expect(cleanText("x".repeat(500), 150)).toHaveLength(150);
    expect(cleanText("   ", 10)).toBeNull();
    expect(cleanText(null, 10)).toBeNull();
  });
  it("reads Open Graph, Twitter-card and title tags from the head only", () => {
    const html = `<!doctype html><html><head><title> Plain &amp; title </title>
      <meta property="og:title" content="OG &quot;Title&quot;">
      <meta property='og:description' content='A <script>alert(1)</script> text'>
      <meta name="twitter:image" content="/img/a.png">
      <meta property="og:site_name" content="Example">
      <!-- <meta property="og:title" content="commented"> -->
      <script>var x = '<meta property="og:title" content="script">';</script>
      <link rel="alternate" type="application/json+oembed" href="/oembed.json">
      </head><body><meta property="og:title" content="late"></body></html>`;
    const head = parseHead(html);
    expect(head.title).toBe("Plain & title");
    expect(head.oembedHref).toBe("/oembed.json");
    const u = fromMeta(head, "https://example.com/post/1");
    expect(u.title).toBe('OG "Title"');
    expect(u.description).toBe("A text");
    expect(u.imageUrl).toBe("https://example.com/img/a.png");
    expect(u.siteName).toBe("Example");
    expect(u.video).toBe(false);
  });
  it("does not accept javascript: or data: images", () => {
    const head = parseHead(
      '<meta property="og:image" content="javascript:alert(1)"><meta property="og:title" content="t">',
    );
    expect(fromMeta(head, "https://e.com/").imageUrl).toBeNull();
    const d = parseHead('<meta property="og:image" content="data:image/png;base64,AAAA">');
    expect(fromMeta(d, "https://e.com/").imageUrl).toBeNull();
  });
  it("falls back to the host name and marks videos", () => {
    const head = parseHead(
      '<meta property="og:type" content="video.other"><meta property="og:title" content="t">',
    );
    const u = fromMeta(head, "https://www.example.org/v");
    expect(u.siteName).toBe("example.org");
    expect(u.video).toBe(true);
  });
  it("takes the text of an embedded post and drops its markup and footer", () => {
    const html =
      '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Hello <a href="https://t.co/x">pic.twitter.com/x</a><br>second line &amp; more</p>&mdash; Ann (@ann) <a href="https://twitter.com/ann/status/1">May 1, 2025</a></blockquote>';
    expect(plainTextFromHtml(html, 300)).toBe("Hello pic.twitter.com/x second line & more");
  });
});

describe("providers and policy", () => {
  it("recognises providers by host and fixes the endpoint host", () => {
    const yt = providerFor(new URL("https://www.youtube.com/watch?v=abc"))!;
    expect(yt.name).toBe("YouTube");
    expect(yt.endpoint(new URL("https://youtu.be/abc"))).toMatch(/^https:\/\/www\.youtube\.com\/oembed\?/);
    expect(providerFor(new URL("https://youtu.be/abc"))?.name).toBe("YouTube");
    expect(providerFor(new URL("https://evil-youtube.com/watch"))).toBeNull();
    expect(providerFor(new URL("https://youtube.com.evil.test/"))).toBeNull();
    const x = providerFor(new URL("https://x.com/a/status/1"))!;
    expect(x.endpoint(new URL("https://x.com/a/status/1"))).toContain(
      encodeURIComponent("https://twitter.com/a/status/1"),
    );
  });
  it("matches a domain and its subdomains only", () => {
    expect(domainMatches("example.com", "example.com")).toBe(true);
    expect(domainMatches("a.b.example.com", "example.com")).toBe(true);
    expect(domainMatches("notexample.com", "example.com")).toBe(false);
    expect(domainMatches("example.com.evil.test", "example.com")).toBe(false);
  });
  it("finds the links of a message and skips code and <angle> links", () => {
    expect(
      extractPreviewUrls(
        "see https://a.example/x, and (https://b.example/y). `https://code.example` <https://hidden.example> https://a.example/x\n```\nhttps://block.example\n```",
      ),
    ).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(
      extractPreviewUrls("1 https://a.test 2 https://b.test 3 https://c.test 4 https://d.test"),
    ).toHaveLength(3);
    expect(extractPreviewUrls("no links, ftp://x.test or javascript:alert(1)")).toEqual([]);
  });
});

// ---- the fetcher against real local servers --------------------------------------------------

const UA = "TinCanLinkPreview/test (+https://example.test)";
const limits = (over: Partial<FetchLimits> = {}): FetchLimits => ({
  maxBytes: 64 * 1024,
  onLimit: "truncate",
  timeoutMs: 2000,
  maxRedirects: 3,
  accept: "*/*",
  types: ["text/html"],
  ...over,
});

describe("safeFetch", () => {
  let server: http.Server;
  let port: number;
  let seen: http.IncomingHttpHeaders[] = [];
  /** The local server stands in for "the public internet"; everything else stays blocked. */
  let resolved: string[] = [];
  const network = (map: Record<string, string[]> = {}): FetchNetwork => ({
    async resolve(host) {
      resolved.push(host);
      const a = map[host];
      if (!a) throw new Error("NXDOMAIN");
      return a;
    },
    allowAddress: (ip) => ip === "127.0.0.1",
    allowedPorts: new Set([port]),
  });
  const at = (path: string, host = "site.test") => `http://${host}:${port}${path}`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.headers);
      const path = req.url ?? "/";
      if (path === "/ok")
        return void res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<title>ok</title>");
      if (path === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        return void res.end("x".repeat(1_000_000));
      }
      if (path === "/json-big") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end("x".repeat(100_000));
      }
      if (path === "/png") return void res.writeHead(200, { "content-type": "image/png" }).end("not html");
      if (path === "/404") return void res.writeHead(404, { "content-type": "text/html" }).end("no");
      if (path === "/slow") {
        res.writeHead(200, { "content-type": "text/html" });
        const t = setInterval(() => res.write("x"), 30);
        res.on("close", () => clearInterval(t));
        return;
      }
      if (path === "/hang") return; // never answers
      if (path === "/to-private")
        return void res.writeHead(302, { location: "http://10.0.0.1/secret" }).end();
      if (path === "/to-metadata")
        return void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      if (path === "/to-loopback6") return void res.writeHead(302, { location: "http://[::1]/" }).end();
      if (path === "/to-file") return void res.writeHead(302, { location: "file:///etc/passwd" }).end();
      if (path === "/to-ok") return void res.writeHead(301, { location: "/ok" }).end();
      if (path === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => void server.close(() => r())));
  beforeEach(() => {
    seen = [];
    resolved = [];
  });

  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e instanceof FetchError ? e.reason : `other:${String(e)}`;
    }
    return "none";
  };

  it("fetches a page, follows a redirect and sends only an honest, minimal request", async () => {
    const r = await safeFetch(at("/to-ok"), limits(), network({ "site.test": ["127.0.0.1"] }), UA);
    expect(r.body.toString()).toBe("<title>ok</title>");
    expect(r.finalUrl).toBe(at("/ok"));
    expect(r.charset).toBe("utf-8");
    const h = seen.at(-1)!;
    expect(h["user-agent"]).toBe(UA);
    expect(h["accept-encoding"]).toBe("identity");
    expect(h.host).toBe(`site.test:${port}`);
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h.referer).toBeUndefined();
  });

  it("refuses private, loopback, metadata and odd-form addresses without connecting", async () => {
    const net = { ...defaultNetwork, allowedPorts: new Set([80, 443, port]) };
    for (const u of [
      `http://127.0.0.1:${port}/ok`,
      "http://10.1.2.3/",
      "http://192.168.0.10/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]/",
      "http://100.64.0.1/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0177.0.0.1/",
      "http://127.1/",
    ])
      expect(await reason(safeFetch(u, limits(), net, UA)), u).toBe("blocked");
    expect(seen).toHaveLength(0);
  });

  it("refuses other schemes, credentials in the address, and ports that are not 80 or 443", async () => {
    const net = network({ "site.test": ["127.0.0.1"] });
    expect(await reason(safeFetch("ftp://site.test/", limits(), net, UA))).toBe("blocked");
    expect(await reason(safeFetch("file:///etc/passwd", limits(), net, UA))).toBe("blocked");
    expect(await reason(safeFetch("javascript:alert(1)", limits(), net, UA))).toBe("blocked");
    expect(await reason(safeFetch(`http://user:pw@site.test:${port}/ok`, limits(), net, UA))).toBe("blocked");
    expect(await reason(safeFetch(`http://site.test:${port + 1}/ok`, limits(), net, UA))).toBe("blocked");
    expect(await reason(safeFetch("not a url", limits(), net, UA))).toBe("blocked");
    expect(seen).toHaveLength(0);
  });

  it("refuses a host name that resolves inside, and one that also resolves inside among public answers", async () => {
    expect(
      await reason(
        safeFetch(at("/ok", "internal.test"), limits(), network({ "internal.test": ["10.0.0.5"] }), UA),
      ),
    ).toBe("blocked");
    expect(
      await reason(
        safeFetch(at("/ok", "localhost"), limits(), { ...network({ localhost: ["127.0.0.1", "::1"] }) }, UA),
      ),
    ).toBe("blocked");
    expect(
      await reason(
        safeFetch(
          at("/ok", "mixed.test"),
          limits(),
          network({ "mixed.test": ["127.0.0.1", "10.0.0.5"] }),
          UA,
        ),
      ),
    ).toBe("blocked");
    expect(await reason(safeFetch(at("/ok", "gone.test"), limits(), network(), UA))).toBe("network");
    expect(seen).toHaveLength(0);
  });

  it("resolves once and connects to the checked address, so a second answer cannot redirect it (DNS rebinding)", async () => {
    let calls = 0;
    const net: FetchNetwork = {
      // The first answer is "public", any later one points inside. Only the first may ever be used.
      async resolve() {
        calls++;
        return calls === 1 ? ["127.0.0.1"] : ["10.0.0.5"];
      },
      allowAddress: (ip) => ip === "127.0.0.1",
      allowedPorts: new Set([port]),
    };
    const r = await safeFetch(at("/ok", "rebind.test"), limits(), net, UA);
    expect(r.body.toString()).toBe("<title>ok</title>");
    expect(calls).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("checks every redirect hop again", async () => {
    const net = network({ "site.test": ["127.0.0.1"] });
    expect(await reason(safeFetch(at("/to-private"), limits(), net, UA))).toBe("blocked");
    expect(await reason(safeFetch(at("/to-metadata"), limits(), net, UA))).toBe("blocked");
    expect(await reason(safeFetch(at("/to-loopback6"), limits(), net, UA))).toBe("blocked");
    expect(await reason(safeFetch(at("/to-file"), limits(), net, UA))).toBe("blocked");
    expect(await reason(safeFetch(at("/loop"), limits(), net, UA))).toBe("redirects");
  });

  it("keeps only the start of a long page, and refuses a long body where it must be whole", async () => {
    const net = network({ "site.test": ["127.0.0.1"] });
    const cut = await safeFetch(at("/big"), limits({ maxBytes: 1000 }), net, UA);
    expect(cut.truncated).toBe(true);
    expect(cut.body).toHaveLength(1000);
    expect(
      await reason(
        safeFetch(
          at("/json-big"),
          limits({ maxBytes: 1000, onLimit: "fail", types: ["application/json"] }),
          net,
          UA,
        ),
      ),
    ).toBe("too_large");
  });

  it("refuses the wrong content type and error statuses", async () => {
    const net = network({ "site.test": ["127.0.0.1"] });
    expect(await reason(safeFetch(at("/png"), limits(), net, UA))).toBe("bad_type");
    expect(await reason(safeFetch(at("/404"), limits(), net, UA))).toBe("status");
  });

  it("gives up on a server that dribbles or never answers", async () => {
    const net = network({ "site.test": ["127.0.0.1"] });
    const t0 = Date.now();
    expect(
      await reason(safeFetch(at("/slow"), limits({ timeoutMs: 400, maxBytes: 10_000_000 }), net, UA)),
    ).toBe("timeout");
    expect(await reason(safeFetch(at("/hang"), limits({ timeoutMs: 400 }), net, UA))).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

// ---- the module end to end ---------------------------------------------------------------------

describe("link previews in a running server", () => {
  let s: TestServer;
  let origin: http.Server;
  let port: number;
  let owner: string;
  let ann: TestUser;
  let bo: TestUser;
  let cy: TestUser;
  let general: string;
  let png: Buffer;
  const hits = new Map<string, number>();

  const call = (token: string) => ({
    get: (path: string) => s.request("GET", `/api/v1${path}`, { token }),
    post: (path: string, body?: unknown) => s.request("POST", `/api/v1${path}`, { token, body }),
    patch: (path: string, body?: unknown) => s.request("PATCH", `/api/v1${path}`, { token, body }),
    put: (path: string, body?: unknown) => s.request("PUT", `/api/v1${path}`, { token, body }),
    del: (path: string) => s.request("DELETE", `/api/v1${path}`, { token }),
  });
  const say = async (token: string, content: string) => {
    await s.running.ports.pubsub.kv.del("rl:msg:*").catch(() => undefined);
    const r = await call(token).post(`/channels/${general}/messages`, { content });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const link = (path: string) => `http://pages.test:${port}${path}`;
  const api = () => s.running.apis.get<LinkPreviewApi>("link-previews")!;
  const permissive = (): FetchNetwork => ({
    resolve: async () => ["127.0.0.1"],
    allowAddress: (ip) => ip === "127.0.0.1",
    allowedPorts: new Set([port]),
  });

  beforeAll(async () => {
    png = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#3366cc" } })
      .png()
      .toBuffer();
    origin = http.createServer((req, res) => {
      const path = req.url ?? "/";
      hits.set(path, (hits.get(path) ?? 0) + 1);
      const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(body);
      if (path.startsWith("/article"))
        return html(`<head><title>Fallback</title><meta property="og:title" content="A &lt;b&gt;great&lt;/b&gt; article">
          <meta property="og:description" content="Short summary"><meta property="og:image" content="/pic.png"></head>`);
      if (path === "/pic.png") return void res.writeHead(200, { "content-type": "image/png" }).end(png);
      if (path === "/discover")
        return html('<head><link rel="alternate" type="application/json+oembed" href="/oembed.json"></head>');
      if (path === "/oembed.json")
        return void res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            title: "Via oEmbed",
            author_name: "Writer",
            provider_name: "Blog",
            html: "<script>alert(1)</script>",
          }),
        );
      if (path === "/empty") return html("<head></head><body>nothing</body>");
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    port = (origin.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => void origin.close(() => r())));

  beforeEach(async () => {
    hits.clear();
    s = await startTestServer({
      config: {
        modules: {
          accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
          "text-chat": { createRate: { max: 1000, windowSecs: 10 } },
        },
      },
    });
    owner = await s.setupOwner();
    ann = await s.register("ann");
    bo = await s.register("bo");
    cy = await s.register("cy");
    general = (await call(owner).get("/channels")).body.channels.find(
      (c: { name: string }) => c.name === "general",
    ).id;
    api().setNetwork(permissive());
  });
  afterEach(async () => {
    await s.close();
  });

  /** Audit entries are written by an event handler a moment after the request returns. */
  const audit = async (action: string, want: number) => {
    for (let i = 0; i < 40; i++) {
      const items = (await call(owner).get(`/audit-log?action=${action}`)).body.items;
      if (items.length >= want) return items;
      await new Promise((r) => setTimeout(r, 25));
    }
    return (await call(owner).get(`/audit-log?action=${action}`)).body.items;
  };
  const enable = (patch: object = {}) =>
    call(owner).patch("/admin/link-previews", { enabled: true, ...patch });

  it("is off by default and fetches nothing", async () => {
    expect((await call(owner).get("/admin/link-previews")).body).toEqual({
      enabled: false,
      allowDomains: [],
      denyDomains: [],
    });
    expect((await call(owner).get("/capabilities")).body.features["link-previews"]).toEqual({
      enabled: false,
    });
    const id = await say(ann.token, link("/article"));
    expect((await call(bo.token).get(`/link-previews/messages/${id}`)).body).toEqual({ previews: [] });
    expect(hits.size).toBe(0);
  });

  it("only the owner may change the settings, and a change is audited", async () => {
    expect((await call(ann.token).patch("/admin/link-previews", { enabled: true })).status).toBe(403);
    expect((await call(ann.token).get("/admin/link-previews")).status).toBe(403);
    expect((await call(owner).patch("/admin/link-previews", { allowDomains: ["not a domain"] })).status).toBe(
      400,
    );
    expect((await enable()).status).toBe(200);
    expect((await call(owner).get("/capabilities")).body.features["link-previews"]).toEqual({
      enabled: true,
    });
    expect(await audit("linkpreviews.settings", 1)).toHaveLength(1);
  });

  it("makes a card from the page's tags, shows text only, and re-hosts a small image", async () => {
    await enable();
    const id = await say(ann.token, `look ${link("/article")} nice`);
    const r = await call(bo.token).get(`/link-previews/messages/${id}`);
    expect(r.status).toBe(200);
    const p = r.body.previews[0];
    expect(p).toMatchObject({
      url: link("/article"),
      title: "A <b>great</b> article",
      description: "Short summary",
      siteName: "pages.test",
      video: false,
      imageWidth: 640,
      imageHeight: 320,
    });
    expect(p.image).toMatch(/^[0-9a-f]{64}$/);
    const img = await s.request("GET", `/api/v1/link-previews/image/${p.image}`, { token: bo.token });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/webp");
    expect(img.headers.get("content-security-policy")).toContain("sandbox");
    expect((await sharp(img.bytes).metadata()).width).toBe(640);
    expect((await s.request("GET", `/api/v1/link-previews/image/${p.image}`)).status).toBe(401);
    expect((await call(bo.token).get(`/link-previews/image/${"0".repeat(64)}`)).status).toBe(404);
    expect((await call(bo.token).get("/link-previews/image/..%2f..%2fetc")).status).toBe(400);
  });

  it("caches, including the answer 'nothing here', and shares the answer between members", async () => {
    await enable();
    const id = await say(ann.token, link("/article"));
    await call(bo.token).get(`/link-previews/messages/${id}`);
    await call(cy.token).get(`/link-previews/messages/${id}`);
    expect(hits.get("/article")).toBe(1);
    const empty = await say(ann.token, link("/empty"));
    expect((await call(bo.token).get(`/link-previews/messages/${empty}`)).body.previews).toEqual([]);
    await call(bo.token).get(`/link-previews/messages/${empty}`);
    expect(hits.get("/empty")).toBe(1);
  });

  it("reads an oEmbed address the page advertises, and never uses its html", async () => {
    await enable();
    const id = await say(ann.token, link("/discover"));
    const r = await call(bo.token).get(`/link-previews/messages/${id}`);
    expect(r.body.previews[0]).toMatchObject({
      title: "Via oEmbed",
      description: "Writer",
      siteName: "Blog",
    });
    expect(JSON.stringify(r.body)).not.toContain("<script");
  });

  it("does not fetch addresses inside the network, even with the real address rules", async () => {
    await enable();
    api().setNetwork({ ...defaultNetwork, allowedPorts: new Set([80, 443, port]) });
    const id = await say(
      ann.token,
      `http://127.0.0.1:${port}/article http://169.254.169.254/latest/meta-data/ http://[::1]:${port}/article`,
    );
    expect((await call(bo.token).get(`/link-previews/messages/${id}`)).body.previews).toEqual([]);
    expect(hits.size).toBe(0);
  });

  it("follows the owner's allow and deny lists", async () => {
    await enable({ denyDomains: ["pages.test"] });
    const id = await say(ann.token, link("/article"));
    expect((await call(bo.token).get(`/link-previews/messages/${id}`)).body.previews).toEqual([]);
    await enable({ denyDomains: [], allowDomains: ["other.example"] });
    expect((await call(bo.token).get(`/link-previews/messages/${id}`)).body.previews).toEqual([]);
    await enable({ allowDomains: ["pages.test"] });
    expect((await call(bo.token).get(`/link-previews/messages/${id}`)).body.previews).toHaveLength(1);
    expect(hits.get("/article")).toBe(1);
  });

  it("limits fetches per person", async () => {
    await enable();
    for (let i = 0; i < 25; i++) {
      const id = await say(ann.token, link(`/article-${i}`));
      await call(bo.token).get(`/link-previews/messages/${id}`);
    }
    expect([...hits.keys()].filter((k) => k.startsWith("/article-"))).toHaveLength(20);
  });

  it("does not show a message's links to someone who cannot see its channel", async () => {
    await enable();
    const id = await say(ann.token, link("/article"));
    const ch = (await call(owner).post("/channels", { name: "secret", kind: "text", isPrivate: true })).body;
    const r = await call(owner).post(`/channels/${ch.id}/messages`, { content: link("/article-secret") });
    const secretId = r.body.id as string;
    expect((await call(bo.token).get(`/link-previews/messages/${secretId}`)).status).toBe(404);
    expect((await call(bo.token).get(`/link-previews/messages/${id}`)).status).toBe(200);
    expect((await call(bo.token).get("/link-previews/messages/nope")).status).toBe(404);
    expect(hits.get("/article-secret")).toBeUndefined();
  });

  it("lets the author or a moderator remove previews, and audits only the moderator", async () => {
    await enable();
    const mod = (await call(owner).get("/roles")).body.find(
      (r: { name: string }) => r.name === "Moderator",
    ).id;
    await call(owner).put(`/members/${cy.id}/roles/${mod}`);

    const mine = await say(ann.token, link("/article"));
    expect((await call(bo.token).get(`/link-previews/messages/${mine}`)).body.previews).toHaveLength(1);
    expect((await call(bo.token).del(`/link-previews/messages/${mine}`)).status).toBe(403);
    expect((await call(ann.token).del(`/link-previews/messages/${mine}`)).status).toBe(204);
    expect((await call(bo.token).get(`/link-previews/messages/${mine}`)).body.previews).toEqual([]);
    expect((await call(owner).get("/audit-log?action=message.preview.remove")).body.items).toHaveLength(0);

    const other = await say(ann.token, link("/article-2"));
    expect((await call(cy.token).del(`/link-previews/messages/${other}`)).status).toBe(204);
    expect((await call(bo.token).get(`/link-previews/messages/${other}`)).body.previews).toEqual([]);
    const entries = await audit("message.preview.remove", 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorId: cy.id, targetId: other });
  });

  it("is not part of the search text", async () => {
    await enable();
    const id = await say(ann.token, link("/article"));
    await call(bo.token).get(`/link-previews/messages/${id}`);
    const found = await call(bo.token).get("/search?q=great");
    expect(found.body.items ?? []).toHaveLength(0);
  });
});
