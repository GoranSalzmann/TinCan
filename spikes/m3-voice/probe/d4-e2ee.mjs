// SPDX-License-Identifier: AGPL-3.0-or-later
// D4: E2EE + simulcast + dynacast + active speaker; late joiner; wrong key; key change; room SID stability.
import { serve, launch, openClient, mint, rates, sleep } from "./browser-lib.mjs";
import { RoomServiceClient } from "livekit-server-sdk";
import { KEY, SECRET } from "./browser-lib.mjs";
const URL_ = process.env.LK_URL ?? "ws://127.0.0.1:7880";
const svc = new RoomServiceClient(process.env.LK_API ?? "http://127.0.0.1:7880", KEY, SECRET);
await serve();
const browser = await launch();

async function scenario(label, e2ee) {
  const room = "vc_d4_" + label;
  const created = await svc.createRoom({ name: room, emptyTimeout: 60, metadata: JSON.stringify({ epoch: 1 }) });
  const key = e2ee ? "correct-horse-battery-staple:" + created.sid : undefined; // T27: salt = room SID
  const out = { label, sid: created.sid };
  const A = await openClient(browser), B = await openClient(browser);
  const join = (p, id, k, extra = {}) => p.evaluate(async (a) => window.connect(a), { url: URL_, token: null, ...extra, e2eeKey: k });
  const tok = async (id) => mint(id, room);
  await A.evaluate(async (a) => { await window.connect(a); await window.room.localParticipant.setMicrophoneEnabled(true); await window.room.localParticipant.setCameraEnabled(true, { resolution: { width: 1280, height: 720, frameRate: 30 } }, { simulcast: true }); }, { url: URL_, token: await tok("A"), e2eeKey: key });
  await B.evaluate(async (a) => window.connect(a), { url: URL_, token: await tok("B"), e2eeKey: key, adaptiveStream: false });
  await sleep(10);
  const rB = await rates(B, 5);
  out.B_inbound_with_key = rB.sub;
  out.B_speakers = await B.evaluate(() => { const s = new Set(); window.events.forEach((e) => (e.speakers ?? []).forEach((x) => s.add(x))); return { activeSpeakersSeen: [...s], eventCount: window.events.filter((e) => e.speakers).length }; });
  out.B_remoteAudioLevel = await B.evaluate(() => [...window.room.remoteParticipants.values()].map((p) => ({ id: p.identity, audioLevel: p.audioLevel, isSpeaking: p.isSpeaking })));
  out.A_publisher = (await rates(A, 4)).pub;
  // late joiner with the same key
  const L = await openClient(browser);
  await L.evaluate(async (a) => window.connect(a), { url: URL_, token: await tok("late"), e2eeKey: key });
  await sleep(8);
  out.late_joiner_inbound = (await rates(L, 4)).sub;
  // wrong key
  if (e2ee) {
    const W = await openClient(browser);
    await W.evaluate(async (a) => window.connect(a), { url: URL_, token: await tok("wrong"), e2eeKey: "not-the-key" });
    await sleep(8);
    out.wrong_key_inbound = (await rates(W, 4)).sub;
    out.wrong_key_events = await W.evaluate(() => window.events.filter((e) => e.speakers).length);
    // key change on publisher + listener (same key index 0 replaced), observe whether media continues
    await A.evaluate(async (k) => { await window.keyProvider.setKey(k); }, "rotated-key:" + created.sid);
    await B.evaluate(async (k) => { await window.keyProvider.setKey(k); }, "rotated-key:" + created.sid);
    await sleep(6);
    out.after_rotation_B_inbound = (await rates(B, 4)).sub;
    // listener lagging a rotation (has old key) for comparison
    await A.evaluate(async (k) => { await window.keyProvider.setKey(k); }, "rotated-again:" + created.sid);
    await sleep(6);
    out.rotation_without_listener_update = (await rates(B, 4)).sub;
  }
  // room metadata + SID survive: participant sees same SID/meta after reconnect of the app (simulated by reading room)
  out.room_after = (await svc.listRooms([room])).map((r) => ({ sid: r.sid, meta: r.metadata, n: r.numParticipants }));
  console.log(JSON.stringify(out, null, 1));
}
if (!process.env.ONLY_E2EE) await scenario("plain", false);
await scenario("e2ee", true);
await browser.close();
process.exit(0);
