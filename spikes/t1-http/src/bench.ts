// T1 throughput and gateway fan-out, server in a child process per framework.
import { fork, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import autocannon from "autocannon";
import { WebSocket } from "ws";
import { CHANNEL, GOOD_TOKEN } from "./shared.js";

const ORIGIN = "https://chat.example.org";

function startServer(fw: string, port: number): Promise<{ child: ChildProcess; startupMs: number; rssMb: number }> {
  return new Promise((res, rej) => {
    const child = fork(new URL("./server.ts", import.meta.url).pathname, [fw, String(port)], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "inherit", "ipc"] });
    child.stdout!.on("data", (d) => { const m = /\{.*"ready".*\}/.exec(d.toString()); if (m) { const j = JSON.parse(m[0]); res({ child, startupMs: j.startupMs, rssMb: j.rssMb }); } });
    child.on("exit", (c) => rej(new Error("server exited " + c)));
  });
}
const rss = (child: ChildProcess) => new Promise<number>((res) => { child.once("message", (m) => res(m as number)); child.send("rss"); });

async function load(url: string, opts: Partial<autocannon.Options> = {}) {
  const r = await autocannon({ url, connections: 50, duration: 10, ...opts });
  return `${Math.round(r.requests.average).toLocaleString().padStart(7)} req/s, p99 ${r.latency.p99} ms, non-2xx ${r.non2xx}`;
}

async function fanout(port: number, sockets: number, messages: number, intervalMs: number) {
  const pending = new Map<string, { t0: number; left: number }>();
  const lat: number[] = [];
  const conns: WebSocket[] = [];
  await Promise.all(Array.from({ length: sockets }, () => new Promise<void>((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`, { origin: ORIGIN });
    conns.push(ws);
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.op === 10) ws.send(JSON.stringify({ op: 2, d: { token: GOOD_TOKEN, client: { name: "b", version: "1", platform: "n" } } }));
      else if (f.t === "READY") res();
      else if (f.t === "MESSAGE_CREATE") { const p = pending.get(f.d.content); if (p) { lat.push(performance.now() - p.t0); p.left--; } }
    });
  })));
  for (let i = 0; i < messages; i++) {
    const content = `fan${i}`;
    pending.set(content, { t0: performance.now(), left: sockets });
    void fetch(`http://127.0.0.1:${port}/api/v1/channels/${CHANNEL}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const deadline = performance.now() + 10_000;
  while ([...pending.values()].some((p) => p.left > 0) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  conns.forEach((c) => c.terminate());
  lat.sort((a, b) => a - b);
  const q = (x: number) => lat[Math.min(lat.length - 1, Math.floor(x * lat.length))]!.toFixed(1);
  return `${lat.length.toLocaleString()}/${(sockets * messages).toLocaleString()} delivered, p50 ${q(0.5)} ms, p99 ${q(0.99)} ms, max ${q(1)} ms`;
}

for (const [fw, port] of [["fastify", 3201], ["hono", 3202]] as const) {
  const { child, startupMs, rssMb } = await startServer(fw, port);
  console.log(`## ${fw}: startup ${startupMs} ms (imports + routes + listen), RSS at ready ${rssMb} MB`);
  const base = `http://127.0.0.1:${port}/api/v1/channels/${CHANNEL}/messages`;
  console.log(`  GET history (50 msgs, zod response)   ${await load(base + "?limit=50")}`);
  console.log(`  POST create (zod body, 201)           ${await load(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "hello world" }) })}`);
  console.log(`  POST invalid body (400 envelope)      ${await load(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "" }) })}`);
  console.log(`  gateway fan-out 200 sockets, 20 msg/s ${await fanout(port, 200, 200, 50)}`);
  console.log(`  gateway fan-out 1000 sockets, 50 msg/s ${await fanout(port, 1000, 200, 20)}`);
  console.log(`  RSS after runs ${await rss(child)} MB\n`);
  child.kill();
}
process.exit(0);
