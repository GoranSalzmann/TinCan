// SPDX-License-Identifier: AGPL-3.0-or-later
// D6: which transport does a client end up on when UDP is blocked / only relay is allowed?
import { serve, launch, openClient, mint, sleep } from "./browser-lib.mjs";
const MODE = process.env.MODE; // normal | tcp | relay
await serve();
const browser = await launch(["--ignore-certificate-errors"]);
const page = await openClient(browser);
const token = await mint("t-" + MODE, "vc_d6");
const res = await page.evaluate(async (a) => {
  const L = window.LivekitClient;
  const room = new L.Room({ adaptiveStream: false });
  window.room = room;
  const rtc = a.relay ? { iceTransportPolicy: "relay" } : undefined;
  try { await room.connect(a.url, a.token, { rtcConfig: rtc }); } catch (e) { return { error: String(e) }; }
  await room.localParticipant.setMicrophoneEnabled(true);
  await new Promise((r) => setTimeout(r, 6000));
  const rep = await room.engine.pcManager.publisher.getStats();
  let out = { state: room.state };
  const cands = {};
  rep.forEach((s) => { if (s.type === "local-candidate" || s.type === "remote-candidate") cands[s.id] = s; });
  rep.forEach((s) => {
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
      const l = cands[s.localCandidateId], r = cands[s.remoteCandidateId];
      out.pair = { local: l && { type: l.candidateType, protocol: l.protocol, relayProtocol: l.relayProtocol, address: l.address }, remote: r && { type: r.candidateType, protocol: r.protocol, address: r.address }, rtt: s.currentRoundTripTime };
    }
    if (s.type === "outbound-rtp" && s.kind === "audio") out.audioBytesSent = s.bytesSent;
  });
  return out;
}, { url: "ws://172.30.0.10:7880", token, relay: MODE.startsWith("relay") });
console.log(MODE, JSON.stringify(res));
await browser.close();
process.exit(0);
