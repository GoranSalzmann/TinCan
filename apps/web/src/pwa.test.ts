// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = (p: string) => join(root, "public", p);

describe("web app manifest", () => {
  const manifest = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8")) as {
    name: string;
    start_url: string;
    scope: string;
    display: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };

  it("is installable: name, start URL, standalone display and a 192 and a 512 icon", () => {
    expect(manifest.name).toBe("Tin Can");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("points only at files that exist", () => {
    for (const icon of manifest.icons) expect(existsSync(pub(icon.src.replace(/^\//, "")))).toBe(true);
  });

  it("is linked from the page together with the icons", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="theme-color"');
    for (const file of [
      "favicon.ico",
      "favicon.svg",
      "favicon-dark.svg",
      "brand/logo.svg",
      "brand/logo-dark.svg",
    ])
      expect(existsSync(pub(file)), file).toBe(true);
  });
});

describe("service worker", () => {
  type Handler = (event: unknown) => void;
  function load() {
    const handlers = new Map<string, Handler>();
    const self = {
      location: { origin: "https://chat.example.com" },
      addEventListener: (type: string, h: Handler) => handlers.set(type, h),
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
    };
    runInNewContext(readFileSync(pub("sw.js"), "utf8"), { self, caches: {}, fetch: vi.fn(), URL });
    return { handlers, self };
  }
  const fetchEvent = (url: string, init: { method?: string; mode?: string } = {}) => {
    // The worker's promise is not awaited here; `caches` is a stub, so let it reject quietly.
    const respondWith = vi.fn((p: Promise<unknown>) => void p.catch(() => undefined));
    return {
      respondWith,
      request: { url, method: init.method ?? "GET", mode: init.mode ?? "no-cors" },
    };
  };

  it("takes over at once", () => {
    const { handlers, self } = load();
    handlers.get("install")?.({});
    expect(self.skipWaiting).toHaveBeenCalled();
  });

  it("never touches the API, the gateway, files, avatars or LiveKit", () => {
    const { handlers } = load();
    for (const path of [
      "/api/v1/channels",
      "/gateway",
      "/files/abc/x.png",
      "/avatars/a.webp",
      "/livekit/rtc",
    ]) {
      const e = fetchEvent(`https://chat.example.com${path}`);
      handlers.get("fetch")?.(e);
      expect(e.respondWith, path).not.toHaveBeenCalled();
    }
  });

  it("ignores other origins and anything but GET", () => {
    const { handlers } = load();
    const other = fetchEvent("https://elsewhere.example/assets/x.js");
    handlers.get("fetch")?.(other);
    expect(other.respondWith).not.toHaveBeenCalled();
    const post = fetchEvent("https://chat.example.com/assets/x.js", { method: "POST" });
    handlers.get("fetch")?.(post);
    expect(post.respondWith).not.toHaveBeenCalled();
  });

  it("handles build files and page navigations", () => {
    const { handlers } = load();
    const asset = fetchEvent("https://chat.example.com/assets/index-abc123.js");
    handlers.get("fetch")?.(asset);
    expect(asset.respondWith).toHaveBeenCalled();
    const page = fetchEvent("https://chat.example.com/channels/42", { mode: "navigate" });
    handlers.get("fetch")?.(page);
    expect(page.respondWith).toHaveBeenCalled();
  });
});
