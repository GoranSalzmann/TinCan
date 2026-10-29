// SPDX-License-Identifier: AGPL-3.0-or-later
// D1: publisher upload vs viewer count (dynacast), 1080p30 simulcast. Run inside the lk network namespace.
import { serve, launch, openClient, mint, rates, sleep } from "./browser-lib.mjs";
const URL_ = process.env.LK_URL ?? "ws://127.0.0.1:7880";
const VIEWERS = Number(process.env.VIEWERS ?? 5);
const MODE = process.env.MODE ?? "high"; // high: viewers request the top layer; low: adaptiveStream with 320px tiles
const stamp = (s) => console.log(`PHASE ${Date.now()} ${s}`);
await serve();
const browser = await launch();
const pub = await openClient(browser);
await pub.evaluate(async (a) => {
  await window.connect(a);
  await window.room.localParticipant.setCameraEnabled(true, { resolution: { width: 1920, height: 1080, frameRate: 30 } }, {
    simulcast: true, videoEncoding: { maxBitrate: 3_500_000, maxFramerate: 30 },
    videoSimulcastLayers: [{ width: 960, height: 540, encoding: { maxBitrate: 600_000, maxFramerate: 30 } }],
  });
}, { url: URL_, token: await mint("pub", "vc_d1"), dynacast: true });
await sleep(6);
const print = (label, r) => console.log(label, JSON.stringify(r.pub));
stamp("viewers=0"); print("viewers=0", await rates(pub, 10));
const viewers = [];
for (let i = 1; i <= VIEWERS; i++) {
  const v = await openClient(browser);
  await v.evaluate(async (a) => { await window.connect(a); }, { url: URL_, token: await mint("v" + i, "vc_d1", { canPublish: false }), adaptiveStream: MODE === "low", tileWidth: MODE === "low" ? 320 : 1280 });
  viewers.push(v);
  if ([1, 3, VIEWERS].includes(i)) {
    await sleep(8);
    stamp(`viewers=${i}`);
    const r = await rates(pub, 10);
    print(`viewers=${i}`, r);
    const vr = await rates(viewers[0], 5);
    console.log(`  viewer1 inbound`, JSON.stringify(vr.sub));
  }
}
stamp("done");
await browser.close();
process.exit(0);
