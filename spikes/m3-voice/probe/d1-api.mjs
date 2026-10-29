// SPDX-License-Identifier: AGPL-3.0-or-later
// D1: room creation, room SID semantics, webhooks, token refresh, updateParticipant, removal.
import http from "node:http";
import WebSocket from "ws";
import { AccessToken, RoomServiceClient, WebhookReceiver } from "livekit-server-sdk";
import { SignalResponse, TrackSource } from "@livekit/protocol";

const HTTP = process.env.LK_HTTP ?? "http://lk:7880";
const WS = HTTP.replace("http", "ws");
const KEY = "devkey", SECRET = "devsecret0123456789devsecret0123456789";
const svc = new RoomServiceClient(HTTP, KEY, SECRET);
const recv = new WebhookReceiver(KEY, SECRET);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  try { const e = await recv.receive(b, req.headers.authorization); log("WEBHOOK", e.event, e.room?.name, e.room?.sid, e.participant?.identity ?? "", e.track?.source ?? ""); }
  catch (err) { log("WEBHOOK-BAD", err.message); }
  res.end("ok");
}).listen(9000);

async function token(identity, grant, ttl = "10m") {
  const t = new AccessToken(KEY, SECRET, { identity, ttl });
  t.addGrant({ roomJoin: true, room: "vc_test", ...grant });
  return t.toJwt();
}
function join(identity, jwt) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}/rtc?access_token=${jwt}&auto_subscribe=0&protocol=16&sdk=js&version=2.0.0`);
    const seen = { msgs: [], refresh: [] };
    ws.binaryType = "arraybuffer";
    ws.on("message", (d) => {
      const m = SignalResponse.fromBinary(new Uint8Array(d));
      const c = m.message.case;
      seen.msgs.push(c);
      if (c === "join") { seen.join = m.message.value; log(identity, "JOIN room.sid=", m.message.value.room?.sid, "meta=", m.message.value.room?.metadata); }
      if (c === "refreshToken") { seen.refresh.push(m.message.value); log(identity, "REFRESH_TOKEN received"); }
      if (c === "update") for (const p of m.message.value.participants) log(identity, "UPDATE", p.identity, "perm=", JSON.stringify(p.permission && { sub: p.permission.canSubscribe, pub: p.permission.canPublish, src: p.permission.canPublishSources }));
      if (c === "leave") log(identity, "LEAVE reason=", m.message.value.reason, "action=", m.message.value.action);
    });
    ws.on("close", (code) => log(identity, "WS CLOSE", code));
    ws.on("open", () => resolve({ ws, seen }));
    ws.on("error", (e) => log(identity, "WS ERROR", e.message));
  });
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

// 1. explicit creation
const r1 = await svc.createRoom({ name: "vc_test", emptyTimeout: 20, departureTimeout: 10, maxParticipants: 25, metadata: JSON.stringify({ epoch: 1 }) });
log("createRoom sid=", r1.sid, "emptyTimeout=", r1.emptyTimeout);
const r1b = await svc.createRoom({ name: "vc_test", emptyTimeout: 20 });
log("createRoom again: same sid?", r1b.sid === r1.sid, "metadata kept:", r1b.metadata);

// 2. join with restricted grant (mic only)
const tA = await token("alice", { canSubscribe: true, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canPublishData: false, canUpdateOwnMetadata: true });
log("token grant:", JSON.stringify(decode(tA).video));
const a = await join("alice", tA);
await sleep(2);
log("participants:", (await svc.listParticipants("vc_test")).map((p) => `${p.identity}:${p.state}`));
// 3. permission downgrade (revoke publish)
await svc.updateParticipant("vc_test", "alice", undefined, { canPublish: false, canSubscribe: true, canPublishData: false, canPublishSources: [] });
await sleep(1);
const p = await svc.getParticipant("vc_test", "alice");
log("after updateParticipant: canPublish=", p.permission?.canPublish);
// 4. wait for server refresh token (observed over 70 s)
log("waiting for server-initiated refresh token ...");
await sleep(65);
log("refresh tokens seen:", a.seen.refresh.length);
for (const r of a.seen.refresh) log("refreshed grant:", JSON.stringify(decode(r.token ?? r).video));
// 5. duplicate identity displaces
const b = await join("alice", await token("alice", { canSubscribe: true }));
await sleep(2);
// 6. removal
await svc.removeParticipant("vc_test", "alice");
await sleep(3);
log("rooms after removal:", (await svc.listRooms()).map((r) => `${r.name}:${r.sid}:${r.numParticipants}`));
// 7. room SID after emptyTimeout
await sleep(25);
log("rooms after emptyTimeout:", (await svc.listRooms()).length);
const r2 = await svc.createRoom({ name: "vc_test", emptyTimeout: 20, metadata: JSON.stringify({ epoch: 1 }) });
log("recreated sid=", r2.sid, "differs:", r2.sid !== r1.sid);
await sleep(3);
process.exit(0);
