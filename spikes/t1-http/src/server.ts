// Starts one framework's server. Usage: tsx src/server.ts <fastify|hono> <port>
import { performance } from "node:perf_hooks";

const t0 = performance.now();
const [fw, portArg] = process.argv.slice(2);
const port = Number(portArg);
const start = fw === "fastify" ? (await import("./fastify-app.js")).startFastify : (await import("./hono-app.js")).startHono;
await start(port);
console.log(JSON.stringify({ ready: true, startupMs: Math.round(performance.now() - t0), rssMb: Math.round(process.memoryUsage().rss / 1e6) }));
process.on("message", (m) => { if (m === "rss") process.send?.(Math.round(process.memoryUsage().rss / 1e6)); });
