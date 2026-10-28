// SPDX-License-Identifier: AGPL-3.0-or-later
import { Op } from "@tincan/shared";
import { gatewayUrl } from "./client.js";

/** One-shot check for the setup wizard (W-30 step 4): can this browser open the gateway and get HELLO? */
export function probeGateway(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(gatewayUrl(window.location));
    } catch {
      resolve(false);
      return;
    }
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.onmessage = (ev) => {
      try {
        done((JSON.parse(String(ev.data)) as { op: number }).op === Op.HELLO);
      } catch {
        done(false);
      }
    };
    socket.onerror = () => done(false);
    socket.onclose = () => done(false);
  });
}
