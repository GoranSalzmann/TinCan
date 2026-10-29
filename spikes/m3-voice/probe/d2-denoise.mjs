// SPDX-License-Identifier: AGPL-3.0-or-later
// D2: CPU cost of the denoiser worklets, as the real-time factor of an OfflineAudioContext render in headless Chromium.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
const root = "/p/node_modules/@sapphi-red/web-noise-suppressor/dist/";
const mime = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
const srv = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/") { res.setHeader("content-type", "text/html"); return res.end("<!doctype html><title>d2</title>"); }
  const f = path.join(root, u);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader("content-type", mime[path.extname(f)] ?? "application/octet-stream"); res.end(fs.readFileSync(f));
}).listen(8098, "127.0.0.1");
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text()); });
await page.goto("http://127.0.0.1:8098/");
const res = await page.evaluate(async () => {
  const lib = await import("/index.js");
  const SECONDS = 20, SR = 48000;
  const out = {};
  async function run(name, make) {
    const ctx = new OfflineAudioContext(1, SR * SECONDS, SR);
    // speech-like stand-in: modulated harmonics + noise (CPU cost does not depend on content; quality needs real recordings)
    const buf = ctx.createBuffer(1, SR * SECONDS, SR); const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = 0.2 * Math.sin(2 * Math.PI * 140 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) + 0.05 * (Math.random() * 2 - 1); }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const node = name === "none" ? null : await make(ctx);
    if (node) { src.connect(node); node.connect(ctx.destination); } else src.connect(ctx.destination);
    src.start();
    const t0 = performance.now(); const rendered = await ctx.startRendering(); const ms = performance.now() - t0; const rd = rendered.getChannelData(0); let e = 0; for (let i = SR; i < rd.length; i++) e += rd[i] * rd[i]; const rms = Math.sqrt(e / (rd.length - SR));
    out[name] = { outRms: +rms.toFixed(4), renderMs: Math.round(ms), realtimeFactor: +((SECONDS * 1000) / ms).toFixed(1), cpuPercentOfOneCore: +((ms / (SECONDS * 1000)) * 100).toFixed(2) };
  }
  await run("none", null);
  await run("rnnoise", async (ctx) => { const bin = await lib.loadRnnoise({ url: "/rnnoise.wasm", simdUrl: "/rnnoise_simd.wasm" }); await ctx.audioWorklet.addModule("/rnnoise/workletProcessor.js"); return new lib.RnnoiseWorkletNode(ctx, { wasmBinary: bin, maxChannels: 1 }); });
  await run("speex", async (ctx) => { const bin = await lib.loadSpeex({ url: "/speex.wasm" }); await ctx.audioWorklet.addModule("/speex/workletProcessor.js"); return new lib.SpeexWorkletNode(ctx, { wasmBinary: bin, maxChannels: 1 }); });
  await run("gtcrn", async (ctx) => { const bin = await lib.loadGtcrn({ url: "/gtcrn.wasm" }); await ctx.audioWorklet.addModule("/gtcrn/workletProcessor.js"); return new lib.GtcrnWorkletNode(ctx, { wasmBinary: bin, maxChannels: 1 }); });
  return out;
});
console.log(JSON.stringify(res, null, 1));
await browser.close(); process.exit(0);
