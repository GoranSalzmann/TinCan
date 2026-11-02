// SPDX-License-Identifier: AGPL-3.0-or-later
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer, type TestUser } from "../../testing/harness.js";
import { isApng, sniffMedia } from "./media.js";
import { makeExcerpt, looksLikeText } from "./excerpt.js";
import { parseRange } from "./range.js";

describe("sniffMedia", () => {
  const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`)]);
  it("recognises containers by their first bytes", () => {
    expect(sniffMedia(ftyp("isom"))).toBe("video/mp4");
    expect(sniffMedia(ftyp("qt  "))).toBe("video/quicktime");
    expect(sniffMedia(ftyp("M4A "))).toBe("audio/mp4");
    expect(sniffMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe("video/webm");
    expect(sniffMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]), "note.weba")).toBe("audio/webm");
    expect(sniffMedia(Buffer.from("OggS\0\0\0\0"))).toBe("audio/ogg");
    expect(sniffMedia(Buffer.from("ID3\x04\0\0\0\0\0\0"))).toBe("audio/mpeg");
    expect(sniffMedia(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg");
    expect(sniffMedia(Buffer.from("RIFF\0\0\0\0WAVEfmt "))).toBe("audio/wav");
    expect(sniffMedia(Buffer.from("fLaC\0\0\0\0"))).toBe("audio/flac");
  });
  it("does not take text or HTML for media", () => {
    expect(sniffMedia(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffMedia(Buffer.from("hello world, this is text"))).toBeNull();
    expect(sniffMedia(Buffer.alloc(0))).toBeNull();
    // UTF-16 text starts with a byte-order mark that looks like an MPEG Layer I frame header.
    expect(sniffMedia(Buffer.from([0xff, 0xfe, 0x57, 0x00, 0x69, 0x00]))).toBeNull();
    expect(sniffMedia(Buffer.from([0xfe, 0xff, 0x00, 0x57]))).toBeNull();
  });
});

describe("parseRange", () => {
  it("handles the single-range forms", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-5000", 100)).toEqual({ start: 50, end: 99 });
  });
  it("says 416 for a range past the end, and ignores what it cannot use", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=9-3", 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
  });
});

describe("makeExcerpt", () => {
  it("keeps 8 lines and says when more follows", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const e = makeExcerpt(Buffer.from(text), text.length)!;
    expect(e.text.split("\n")).toHaveLength(8);
    expect(e.truncated).toBe(true);
    expect(makeExcerpt(Buffer.from("a\nb\n"), 4)).toEqual({ text: "a\nb", truncated: false });
  });
  it("caps characters", () => {
    const e = makeExcerpt(Buffer.from("x".repeat(1000)), 1000)!;
    expect(e.text).toHaveLength(600);
    expect(e.truncated).toBe(true);
  });
  it("reads UTF-8 with a BOM and UTF-16 with or without a BOM", () => {
    const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo")]);
    expect(makeExcerpt(bom8, bom8.length)!.text).toBe("héllo");
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")]);
    expect(makeExcerpt(le, le.length)!.text).toBe("héllo");
    const swapped = Buffer.from("héllo", "utf16le");
    swapped.swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]);
    expect(makeExcerpt(be, be.length)!.text).toBe("héllo");
    expect(makeExcerpt(Buffer.from("hello world", "utf16le"), 22)!.text).toBe("hello world");
  });
  it("does not break on a character cut by the end of the sample", () => {
    const full = Buffer.from("ab€");
    expect(makeExcerpt(full.subarray(0, 4), 100)!.text).toBe("ab");
  });
  it("refuses binary data, invalid UTF-8 and NUL bytes", () => {
    expect(makeExcerpt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), 8)).toBeNull();
    expect(makeExcerpt(Buffer.from([0x68, 0x69, 0xff, 0xfe, 0xfd]), 5)).toBeNull();
    expect(makeExcerpt(Buffer.from("ab\0cd"), 5)).toBeNull();
    expect(makeExcerpt(Buffer.alloc(0), 0)).toBeNull();
  });
  it("removes bidi overrides and control characters, and keeps markup as plain text", () => {
    const e = makeExcerpt(Buffer.from("<script>alert(1)</script>‮gnp.exe\u0007\r\nnext"), 40)!;
    expect(e.text).toBe("<script>alert(1)</script>gnp.exe\nnext");
  });
  it("picks text files by extension or declared type", () => {
    expect(looksLikeText("a.md", undefined)).toBe(true);
    expect(looksLikeText("page.HTML", "application/octet-stream")).toBe(true);
    expect(looksLikeText("data", "application/json")).toBe(true);
    expect(looksLikeText("photo.jpg", undefined)).toBe(false);
    expect(looksLikeText("archive.zip", "application/zip")).toBe(false);
  });
});

describe("isApng", () => {
  it("finds acTL before the image data", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    expect(isApng(png)).toBe(false);
    // A minimal acTL chunk after IHDR; the scan does not check CRCs.
    const chunk = Buffer.concat([
      Buffer.from([0, 0, 0, 8]),
      Buffer.from("acTL"),
      Buffer.alloc(8),
      Buffer.alloc(4),
    ]);
    expect(isApng(Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]))).toBe(true);
  });
});

let s: TestServer;
let ann: TestUser;
const upload = (bytes: Buffer | string, filename: string, type: string) => {
  const f = new FormData();
  f.set("file", new Blob([bytes], { type }), filename);
  return s.request("POST", "/api/v1/uploads", { token: ann.token, form: f });
};
const get = (id: string, name: string, headers: Record<string, string> = {}) =>
  s.request("GET", `/api/v1/files/${id}/${name}`, { token: ann.token, headers });

describe("uploaded media and text", () => {
  beforeEach(async () => {
    s = await startTestServer({
      config: {
        modules: { accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } } },
      },
    });
    await s.setupOwner();
    ann = await s.register("ann");
  });
  afterEach(async () => {
    await s.close();
  });

  const mp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypisom"),
    Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256)),
  ]);

  it("stores a sniffed video and serves it inline with range support", async () => {
    const up = await upload(mp4, "clip.mp4", "application/octet-stream");
    expect(up.status).toBe(201);
    expect(up.body.contentType).toBe("video/mp4");

    const full = await get(up.body.id, "clip.mp4");
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(full.bytes.equals(mp4)).toBe(true);

    const part = await get(up.body.id, "clip.mp4", { range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 10-19/${mp4.length}`);
    expect(part.headers.get("content-length")).toBe("10");
    expect(part.bytes.equals(mp4.subarray(10, 20))).toBe(true);

    const tail = await get(up.body.id, "clip.mp4", { range: "bytes=-5" });
    expect(tail.status).toBe(206);
    expect(tail.bytes.equals(mp4.subarray(mp4.length - 5))).toBe(true);

    const past = await get(up.body.id, "clip.mp4", { range: `bytes=${mp4.length}-` });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe(`bytes */${mp4.length}`);
  });

  it("does not trust a media label on other bytes", async () => {
    const up = await upload("<html><script>alert(1)</script></html>", "x.mp4", "video/mp4");
    expect(up.body.contentType).toBe("application/octet-stream");
    const res = await get(up.body.id, "x.mp4");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("flags animated images", async () => {
    // Two 1×1 frames with a NETSCAPE loop block, written out by hand.
    const frame = [0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0];
    const gif = Buffer.from([
      ...Buffer.from("GIF89a"),
      1,
      0,
      1,
      0,
      0x80,
      0,
      0,
      0,
      0,
      0,
      255,
      255,
      255,
      0x21,
      0xff,
      11,
      ...Buffer.from("NETSCAPE2.0"),
      3,
      1,
      0,
      0,
      0,
      ...frame,
      ...frame,
      0x3b,
    ]);
    const a = await upload(gif, "anim.gif", "image/gif");
    expect(a.body).toMatchObject({ contentType: "image/gif", animated: true, hasThumbnail: true });
    const still = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } })
      .gif()
      .toBuffer();
    const b = await upload(still, "still.gif", "image/gif");
    expect(b.body.animated).toBe(false);
  });

  it("keeps the first lines of a text file, html included, as plain source", async () => {
    const html = "<h1>Hi</h1>\n<script>alert(1)</script>\n" + "x\n".repeat(30);
    const up = await upload(html, "page.html", "text/html");
    expect(up.body.contentType).toBe("application/octet-stream");
    expect(up.body.excerpt.startsWith("<h1>Hi</h1>\n<script>alert(1)</script>")).toBe(true);
    expect(up.body.excerptTruncated).toBe(true);
  });

  it("makes no excerpt for binary data named like text, or for other files", async () => {
    const bin = await upload(Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0, 0, 9, 8]), "data.txt", "text/plain");
    expect(bin.body.excerpt).toBeNull();
    const other = await upload("hello", "x.bin", "application/octet-stream");
    expect(other.body.excerpt).toBeNull();
  });
});
