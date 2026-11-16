// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepFilterStatus } from "./status.js";

vi.mock("./worklet.ts?worker&url", () => ({ default: "/worklet.js" }));

/** A response whose body arrives in `chunks` pieces, like a real download. */
function streamed(bytes: number, chunks: number, type = "application/octet-stream"): Response {
  const size = Math.ceil(bytes / chunks);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close();
      const n = Math.min(size, bytes - sent);
      sent += n;
      c.enqueue(new Uint8Array(n));
    },
  });
  return new Response(body, { headers: { "content-type": type } });
}

const html = () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } });

async function load() {
  vi.resetModules();
  const loader = await import("./index.js");
  const { useDeepFilterStatus } = await import("./status.js");
  const seen: DeepFilterStatus[] = [];
  useDeepFilterStatus.subscribe((s) => seen.push({ ...s }));
  return { loader, status: useDeepFilterStatus, seen };
}

describe("DeepFilterNet loader", () => {
  beforeEach(() => {
    vi.spyOn(WebAssembly, "compile").mockResolvedValue({});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports bytes against the manifest's total while it downloads, then is ready", async () => {
    const fetch = vi.fn((url: string) => {
      if (url.endsWith("manifest.json")) return Promise.resolve(Response.json({ wasm: 3000, model: 5000 }));
      if (url.endsWith(".wasm")) return Promise.resolve(streamed(3000, 3));
      return Promise.resolve(streamed(5000, 5));
    });
    vi.stubGlobal("fetch", fetch);
    const { loader, status, seen } = await load();

    const { model } = await loader.loadDeepFilterAssets();
    expect(model.byteLength).toBe(5000);
    const downloading = seen.filter((s) => s.phase === "downloading");
    expect(downloading[0]).toMatchObject({ loaded: 0, total: 8000 });
    expect(downloading.map((s) => s.loaded)).toEqual(
      [...downloading.map((s) => s.loaded)].sort((a, b) => a - b),
    );
    expect(downloading.at(-1)!.loaded).toBe(8000);
    expect(status.getState().phase).toBe("ready");

    // Once per page load: a second pipeline does not download again.
    await loader.loadDeepFilterAssets();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("says the server does not have it, without downloading anything, when the manifest is missing", async () => {
    // A single-page-app fallback answers with the page, status 200.
    const fetch = vi.fn((_url: string) => Promise.resolve(html()));
    vi.stubGlobal("fetch", fetch);
    const { loader, status } = await load();

    await expect(loader.deepFilterManifest()).rejects.toThrow("not installed on this server");
    await expect(loader.loadDeepFilterAssets()).rejects.toThrow("not installed on this server");
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith("manifest.json"))).toBe(true);
    expect(status.getState().phase).toBe("idle");
  });

  it("tries again after a failed download instead of remembering the failure", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("manifest.json")) return Promise.resolve(Response.json({ wasm: 10, model: 10 }));
        if (fail) return Promise.resolve(new Response("", { status: 503 }));
        return Promise.resolve(streamed(10, 1));
      }),
    );
    const { loader, status } = await load();

    await expect(loader.loadDeepFilterAssets()).rejects.toThrow("HTTP 503");
    expect(status.getState()).toMatchObject({ phase: "idle", loaded: 0, total: 0 });
    fail = false;
    await expect(loader.loadDeepFilterAssets()).resolves.toBeDefined();
  });
});
