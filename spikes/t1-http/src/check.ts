// T1 feature checks, run identically against both frameworks.
import { WebSocket } from "ws";
import { validate } from "@readme/openapi-parser";
import { CHANNEL, GOOD_TOKEN } from "./shared.js";
import { startFastify } from "./fastify-app.js";
import { startHono } from "./hono-app.js";

type Row = [string, string];
const ORIGIN = "https://chat.example.org";

async function req(base: string, method: string, path: string, body?: unknown, raw?: string) {
  const r = await fetch(base + path, { method, headers: body || raw ? { "content-type": "application/json" } : {}, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

function wsSession(url: string, origin: string, script: (ws: WebSocket, frames: any[]) => void): Promise<{ frames: any[]; close?: number; httpStatus?: number }> {
  return new Promise((res) => {
    const frames: any[] = [];
    const ws = new WebSocket(url, { origin });
    ws.on("unexpected-response", (_req, resp) => res({ frames, httpStatus: resp.statusCode }));
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    ws.on("open", () => script(ws, frames));
    ws.on("close", (code) => res({ frames, close: code }));
    ws.on("error", () => {});
    setTimeout(() => { ws.terminate(); res({ frames }); }, 3000);
  });
}

async function checks(base: string): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (k: string, v: unknown) => rows.push([k, typeof v === "string" ? v : JSON.stringify(v)]);
  const p = `/api/v1/channels/${CHANNEL}/messages`;

  const ok = await req(base, "POST", p, { content: "hi" });
  add("POST valid -> status", ok.status);
  add("internal field leaked in response (passwordHash)", "passwordHash" in ok.json ? "YES (leaked)" : "no (stripped)");
  const bad = await req(base, "POST", p, { content: "" });
  add("POST empty content -> status / error.code", `${bad.status} / ${bad.json?.error?.code}`);
  const badParam = await req(base, "POST", "/api/v1/channels/not-a-ulid/messages", { content: "x" });
  add("POST bad :channelId -> status / error.code", `${badParam.status} / ${badParam.json?.error?.code}`);
  const badJson = await req(base, "POST", p, undefined, "{not json");
  add("POST malformed JSON -> status / error.code", `${badJson.status} / ${badJson.json?.error?.code}`);
  const big = await req(base, "POST", p, { content: "x".repeat(100_000) });
  add("POST 100 kB body (limit 64 KiB) -> status / error.code", `${big.status} / ${big.json?.error?.code}`);
  const hist = await req(base, "GET", `${p}?limit=5`);
  add("GET ?limit=5 (coerced) -> status / items", `${hist.status} / ${Array.isArray(hist.json) ? hist.json.length : "?"}`);
  const histBad = await req(base, "GET", `${p}?limit=abc`);
  add("GET ?limit=abc -> status / error.code", `${histBad.status} / ${histBad.json?.error?.code}`);
  const broken = await req(base, "GET", "/api/v1/broken");
  add("handler returns schema-violating body -> status", `${broken.status} ${broken.status === 200 ? "(sent unchecked: " + JSON.stringify(broken.json) + ")" : "(caught)"}`);

  const doc = (await req(base, "GET", "/api/v1/openapi.json")).json;
  add("OpenAPI version", doc.openapi);
  add("OpenAPI paths", Object.keys(doc.paths ?? {}));
  const post = doc.paths?.["/api/v1/channels/{channelId}/messages"]?.post;
  const bodySchema = post?.requestBody?.content?.["application/json"]?.schema;
  add("request body schema carries maxLength 4000", JSON.stringify(bodySchema ?? {}).includes('"maxLength":4000'));
  add("ULID pattern on path param", JSON.stringify(post?.parameters ?? []).includes("0-9A-HJKMNP-TV-Z"));
  add("201 response schema present", Boolean(post?.responses?.["201"]?.content));
  try { await validate(structuredClone(doc)); add("OpenAPI document validates (@readme/openapi-parser)", "valid"); }
  catch (e) { add("OpenAPI document validates (@readme/openapi-parser)", "INVALID: " + String((e as Error).message).split("\n")[0]); }

  const url = base.replace("http", "ws") + "/gateway";
  const s1 = await wsSession(url, ORIGIN, (ws, frames) => {
    ws.send(JSON.stringify({ op: 2, d: { token: GOOD_TOKEN, client: { name: "check", version: "1", platform: "node" } } }));
    setTimeout(() => ws.send(JSON.stringify({ op: 1, d: 1 })), 50);
    setTimeout(async () => { await req(base, "POST", p, { content: "fanout" }); }, 100);
    setTimeout(() => ws.close(1000), 300);
    void frames;
  });
  add("WS: HELLO, READY, HEARTBEAT_ACK, MESSAGE_CREATE", s1.frames.map((f) => f.t ?? f.op));
  const s2 = await wsSession(url, "https://evil.example", () => {});
  add("WS: foreign Origin rejected before upgrade (HTTP status)", s2.httpStatus ?? `upgraded! close ${s2.close}`);
  const s3 = await wsSession(url, ORIGIN, (ws) => ws.send(JSON.stringify({ op: 2, d: { token: "nope", client: { name: "c", version: "1", platform: "n" } } })));
  add("WS: bad token -> close code", s3.close);
  // Valid frames that are too large: the limit must come from the WS layer, not from a parse error.
  const bigFrame = (bytes: number) => (ws: WebSocket) => {
    ws.send(JSON.stringify({ op: 2, d: { token: GOOD_TOKEN, client: { name: "c", version: "1", platform: "n" } } }));
    ws.send(JSON.stringify({ op: 4, d: { cmd: "typing", args: "x".repeat(bytes), id: "big" } }));
    setTimeout(() => ws.close(1000), 1500);
  };
  const verdict = (s: { frames: any[]; close?: number }) => s.close === 1009 ? "closed 1009 (too big)" : s.frames.some((f) => f.op === 5) ? `accepted and processed (close ${s.close})` : `close ${s.close}`;
  add("WS: valid 70 KiB frame (limit 64 KiB)", verdict(await wsSession(url, ORIGIN, bigFrame(70 * 1024))));
  add("WS: valid 20 MiB frame", verdict(await wsSession(url, ORIGIN, bigFrame(20 * 1024 * 1024))));
  return rows;
}

const f = await startFastify(3101);
const fr = await checks("http://127.0.0.1:3101");
await f.close();
const h = await startHono(3102);
const hr = await checks("http://127.0.0.1:3102");
await h.close();

console.log(`| Check | Fastify | Hono |\n|---|---|---|`);
fr.forEach(([k, v], i) => console.log(`| ${k} | ${v} | ${hr[i]![1]} |`));
process.exit(0);
