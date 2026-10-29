// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared harness: a static page serving livekit-client, headless Chromium with fake media devices.
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { AccessToken, TrackSource } from "livekit-server-sdk";

export const KEY = process.env.LK_KEY ?? "devkey";
export const SECRET = process.env.LK_SECRET ?? "devsecret0123456789devsecret0123456789";
const dist = "/p/node_modules/livekit-client/dist/";
export const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

export function serve(port = 8099) {
  const files = {
    "/": ["<!doctype html><title>spike</title><body></body>", "text/html"],
    "/lk.js": [fs.readFileSync(dist + "livekit-client.umd.js"), "text/javascript"],
    "/e2ee.worker.js": [fs.readFileSync(dist + "livekit-client.e2ee.worker.js"), "text/javascript"],
  };
  const srv = http.createServer((req, res) => {
    const f = files[req.url.split("?")[0]];
    if (!f) { res.statusCode = 404; return res.end(); }
    res.setHeader("content-type", f[1]); res.end(f[0]);
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

export async function mint(identity, room, grant = {}) {
  const t = new AccessToken(KEY, SECRET, { identity, ttl: "30m" });
  t.addGrant({ roomJoin: true, room, canSubscribe: true, canPublish: true, canPublishData: false, ...grant });
  return t.toJwt();
}
export { TrackSource };

export async function launch(extraArgs = []) {
  return chromium.launch({
    executablePath: process.env.CHROMIUM,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", ...extraArgs],
  });
}

/** Opens a page with LivekitClient loaded and the helper functions attached to window. */
export async function openClient(browser, { relayOnly = false } = {}) {
  const ctx = await browser.newContext({ permissions: ["microphone", "camera"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto("http://127.0.0.1:8099/");
  await page.addScriptTag({ url: "/lk.js" });
  await page.evaluate((relayOnly) => {
    const L = window.LivekitClient;
    window.rooms = {};
    window.connect = async (o) => {
      const opts = {
        adaptiveStream: o.adaptiveStream ?? false,
        dynacast: o.dynacast ?? true,
        publishDefaults: { simulcast: o.simulcast ?? true, videoCodec: o.codec ?? "vp8", dtx: true, red: true, ...(o.publishDefaults ?? {}) },
      };
      if (o.e2eeKey) {
        const keyProvider = new L.ExternalE2EEKeyProvider();
        await keyProvider.setKey(o.e2eeKey);
        opts.e2ee = { keyProvider, worker: new Worker("/e2ee.worker.js") };
        window.keyProvider = keyProvider;
      }
      const room = new L.Room(opts);
      window.room = room;
      window.events = [];
      room.on(L.RoomEvent.ActiveSpeakersChanged, (sp) => window.events.push({ t: Date.now(), speakers: sp.map((s) => s.identity) }));
      room.on(L.RoomEvent.TrackSubscribed, (tr, pub, p) => {
        window.events.push({ t: Date.now(), subscribed: p.identity + ":" + pub.source });
        if (tr.kind === "video") { const el = tr.attach(); el.style.width = (o.tileWidth ?? 1280) + "px"; el.muted = true; document.body.appendChild(el); }
        else { const el = tr.attach(); document.body.appendChild(el); }
      });
      room.on(L.RoomEvent.Disconnected, (r) => window.events.push({ t: Date.now(), disconnected: r }));
      if (o.e2eeKey) await room.setE2EEEnabled(true);
      await room.connect(o.url, o.token, { autoSubscribe: o.autoSubscribe ?? true, ...(o.rtcConfig ? {} : {}) });
      return { sid: await room.getSid(), identity: room.localParticipant.identity };
    };
  }, relayOnly);
  return page;
}

/** Sums outbound/inbound rtp bytes over a window; returns kbps per direction and per-layer. */
export async function rates(page, seconds) {
  const grab = () => page.evaluate(async () => {
    const out = { pub: {}, sub: {} };
    const r = window.room.engine.pcManager;
    for (const [k, t] of [["pub", r.publisher], ["sub", r.subscriber]]) {
      if (!t) continue;
      const rep = await t.getStats();
      rep.forEach((s) => {
        if (s.type === "outbound-rtp" && !s.isRemote) out.pub[(s.kind) + ":" + (s.rid ?? "-")] = { bytes: s.bytesSent, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, active: s.active };
        if (s.type === "inbound-rtp") out.sub[s.kind + ":" + s.ssrc] = { bytes: s.bytesReceived, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, lost: s.packetsLost, jitter: s.jitter };
      });
    }
    return out;
  });
  const a = await grab(); await sleep(seconds); const b = await grab();
  const diff = (x, y) => Object.fromEntries(Object.entries(y).map(([k, v]) => [k, { kbps: Math.round(((v.bytes - (x[k]?.bytes ?? 0)) * 8) / seconds / 1000), w: v.w, h: v.h, fps: v.fps && Math.round(v.fps), active: v.active, lost: v.lost }]));
  return { pub: diff(a.pub, b.pub), sub: diff(a.sub, b.sub) };
}
