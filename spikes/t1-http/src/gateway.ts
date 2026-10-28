// Framework-independent gateway session (07 §4). Each framework only has to
// hand over a `ws` socket; how much it takes to get there is what T1 compares.
import type { WebSocket } from "ws";
import { ClientFrame, GOOD_TOKEN } from "./shared.js";

const SEND_QUEUE_CAP = 1024 * 1024; // bytes buffered before a slow consumer is dropped (05 §5)
const sessions = new Set<WebSocket>();
let seq = 0;

export function onConnection(ws: WebSocket) {
  let identified = false;
  ws.send(JSON.stringify({ op: 10, d: { heartbeatIntervalMs: 25_000, apiVersion: 1 } })); // HELLO
  const identifyTimer = setTimeout(() => { if (!identified) ws.close(4003, "identify timeout"); }, 10_000);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return ws.close(4002, "binary not supported");
    let frame;
    try { frame = ClientFrame.safeParse(JSON.parse(data.toString())); } catch { return ws.close(4002, "decode error"); }
    if (!frame.success) return ws.close(4001, "invalid frame");
    const f = frame.data;
    if (f.op === 1) return ws.send(JSON.stringify({ op: 11 }));
    if (f.op === 2) {
      if (identified) return ws.close(4005, "already authenticated");
      if (f.d.token !== GOOD_TOKEN) return ws.close(4004, "authentication failed");
      identified = true;
      clearTimeout(identifyTimer);
      sessions.add(ws);
      return ws.send(JSON.stringify({ op: 0, t: "READY", s: ++seq, d: { sessionId: "s" + seq } }));
    }
    if (!identified) return ws.close(4003, "not authenticated");
    ws.send(JSON.stringify({ op: 5, d: { id: f.d.id, ok: true } }));
  });
  ws.on("close", () => { clearTimeout(identifyTimer); sessions.delete(ws); });
}

export function broadcast(t: string, d: unknown) {
  const frame = JSON.stringify({ op: 0, t, s: ++seq, d });
  for (const ws of sessions) {
    if (ws.bufferedAmount > SEND_QUEUE_CAP) { ws.close(4010, "slow consumer"); continue; }
    ws.send(frame);
  }
}

export const sessionCount = () => sessions.size;
