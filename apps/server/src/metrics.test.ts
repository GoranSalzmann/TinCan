// SPDX-License-Identifier: AGPL-3.0-or-later
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetricsRegistry } from "./framework/metrics.js";
import { ALL_MODULES } from "./modules/index.js";
import { FakeLiveKit, jsonVerifier } from "./modules/voice/fake-livekit.js";
import { createVoiceModule } from "./modules/voice/index.js";
import { startTestServer, type TestServer } from "./testing/harness.js";

const TOKEN = "scrape-token-0123456789abcdef";
let s: TestServer;
let owner: string;

beforeEach(async () => {
  const fake = new FakeLiveKit();
  s = await startTestServer({
    config: {
      livekit: {
        url: "ws://localhost/livekit",
        apiKey: "devkey",
        apiSecret: "metrics-test-".padEnd(40, "x"),
      },
      modules: {
        accounts: { signup: "open", argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
        voice: { reconcileIntervalMs: 3_600_000 },
        metrics: { token: TOKEN },
      },
    },
    modules: [
      ...ALL_MODULES.filter((m) => m.id !== "voice"),
      createVoiceModule({ rooms: fake, verify: jsonVerifier }),
    ],
  });
  owner = await s.setupOwner();
});
afterEach(async () => {
  await s.close();
});

/** What a request arriving through Caddy looks like: the proxy adds X-Forwarded-For. */
const viaProxy = { "x-forwarded-for": "203.0.113.9" };
const scrape = (opts: { token?: string; headers?: Record<string, string> } = {}) =>
  s.request("GET", "/api/v1/metrics", {
    ...(opts.token ? { token: opts.token } : {}),
    headers: { ...viaProxy, ...opts.headers },
  });
const text = (r: { bytes: Buffer }) => r.bytes.toString("utf8");

describe("GET /metrics (14 §8)", () => {
  it("answers the scraper token and the owner, and nobody else behind the proxy", async () => {
    expect((await scrape()).status).toBe(403);
    expect((await scrape({ token: "wrong-token-wrong-token" })).status).toBe(403);
    const member = await s.register("ann");
    expect((await scrape({ token: member.token })).status).toBe(403);
    expect((await scrape({ token: TOKEN })).status).toBe(200);
    expect((await scrape({ token: owner })).status).toBe(200);
  });

  it("answers a direct loopback request without credentials, but not one that came through the proxy", async () => {
    const direct = await s.request("GET", "/api/v1/metrics");
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-type")).toContain("text/plain");
  });

  it("is Prometheus text with HTTP, voice, upload and process series", async () => {
    await s.request("GET", "/api/v1/capabilities");
    const body = text(await scrape({ token: TOKEN }));
    for (const name of [
      "tincan_http_requests_total",
      "tincan_http_request_duration_seconds_bucket",
      "tincan_reconcile_repairs_total",
      "tincan_voice_webhooks_total",
      "tincan_uploads_in_flight_bytes",
      "tincan_job_runs_total",
      "tincan_outbox_backlog",
      "tincan_gateway_sessions",
      "process_resident_memory_bytes",
      "nodejs_eventloop_lag_p99_seconds",
      "tincan_build_info",
    ])
      expect(body, name).toContain(name);
    // Every repair kind is present from the start, so a rate() alert has a series to watch.
    expect(body).toMatch(/tincan_reconcile_repairs_total\{kind="permission_updated"\} 0/);
    expect(body).toMatch(/# TYPE tincan_http_requests_total counter/);
  });

  it("labels requests by route pattern, never by the ids in the path", async () => {
    const ann = await s.register("ann");
    await s.request("GET", `/api/v1/channels/${"x".repeat(26)}/messages`, { token: ann.token });
    const body = text(await scrape({ token: TOKEN }));
    expect(body).toContain(`route="/api/v1/channels/:id/messages"`);
    expect(body).not.toContain("xxxxxxxx");
  });

  it("counts audit events and returns the request id on every answer", async () => {
    const ann = await s.register("ann");
    await s.request("POST", `/api/v1/members/${ann.id}/kick`, { token: owner, body: {} });
    const res = await s.request("GET", "/api/v1/capabilities", {
      headers: { "x-request-id": "req-0123456789" },
    });
    expect(res.headers.get("x-request-id")).toBe("req-0123456789");
    expect((await s.request("GET", "/api/v1/capabilities")).headers.get("x-request-id")).toMatch(/\w{10,}/);
    expect(text(await scrape({ token: TOKEN }))).toMatch(
      /tincan_audit_events_total\{action="member.kick"\} 1/,
    );
  });

  it("counts uploads and shows the memory an image held while it was decoded", async () => {
    const ann = await s.register("ann");
    const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#369" } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("file", new Blob([png], { type: "image/png" }), "a.png");
    expect((await s.request("POST", "/api/v1/uploads", { token: ann.token, form })).status).toBe(201);
    const body = text(await scrape({ token: TOKEN }));
    expect(body).toMatch(/tincan_uploads_total 1/);
    expect(body).toContain(`tincan_upload_bytes_total ${png.length}`);
    expect(body).toContain(`tincan_uploads_in_flight_peak_bytes ${png.length}`);
    expect(body).toMatch(/tincan_uploads_in_flight_bytes 0/);
  });
});

describe("the registry", () => {
  it("escapes label values and renders histograms cumulatively", async () => {
    const m = new MetricsRegistry();
    m.counter("c_total", "help", ["a"]).inc({ a: 'x"y\\z\n' });
    const h = m.histogram("h_seconds", "help", [], [1, 5]);
    h.observe(0.5);
    h.observe(3);
    h.observe(9);
    const out = await m.render();
    expect(out).toContain('c_total{a="x\\"y\\\\z\\n"} 1');
    expect(out).toContain('h_seconds_bucket{le="1"} 1');
    expect(out).toContain('h_seconds_bucket{le="5"} 2');
    expect(out).toContain('h_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain("h_seconds_sum 12.5");
  });

  it("survives a collector that throws and counts it", async () => {
    const m = new MetricsRegistry();
    m.collect(() => {
      throw new Error("boom");
    });
    expect(await m.render()).toContain("tincan_metrics_collector_failures_total 1");
  });
});
