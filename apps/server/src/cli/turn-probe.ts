// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { connect as tlsConnect } from "node:tls";

/**
 * A minimal STUN/TURN client (RFC 8489, RFC 8656) for `tincan doctor` and tools/turn-test: just enough to ask a TURN
 * server "are you there" over UDP and TLS without credentials. An Allocate request with no credentials makes a real TURN
 * server answer 401 with a realm and nonce, which proves the TURN service itself (not just an open port) is listening.
 */

const COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_ERROR = 0x0113;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_REALM = 0x0014;

export type ProbeKind = "binding" | "allocate";

export interface ProbeResult {
  /** "ok" when the server answered the way a TURN server should. */
  ok: boolean;
  detail: string;
  /** For allocate: the error code the server answered (401 is the expected one). */
  errorCode?: number;
  realm?: string;
}

export function encodeRequest(kind: ProbeKind, txId: Buffer = randomBytes(12)): Buffer {
  const attrs =
    kind === "allocate"
      ? Buffer.concat([
          Buffer.from([ATTR_REQUESTED_TRANSPORT >> 8, ATTR_REQUESTED_TRANSPORT & 0xff, 0, 4]),
          Buffer.from([17, 0, 0, 0]), // UDP, then RFFU
        ])
      : Buffer.alloc(0);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(kind === "allocate" ? ALLOCATE_REQUEST : BINDING_REQUEST, 0);
  head.writeUInt16BE(attrs.length, 2);
  head.writeUInt32BE(COOKIE, 4);
  txId.copy(head, 8);
  return Buffer.concat([head, attrs]);
}

export interface Decoded {
  type: number;
  txId: Buffer;
  errorCode?: number;
  realm?: string;
}

/** Returns null for anything that is not a complete STUN message. */
export function decodeMessage(buf: Buffer): Decoded | null {
  if (buf.length < 20 || buf.readUInt32BE(4) !== COOKIE) return null;
  const len = buf.readUInt16BE(2);
  if (buf.length < 20 + len) return null;
  const out: Decoded = { type: buf.readUInt16BE(0), txId: buf.subarray(8, 20) };
  let off = 20;
  while (off + 4 <= 20 + len) {
    const t = buf.readUInt16BE(off);
    const l = buf.readUInt16BE(off + 2);
    const v = buf.subarray(off + 4, off + 4 + l);
    if (t === ATTR_ERROR_CODE && v.length >= 4) out.errorCode = (v[2]! & 0x07) * 100 + v[3]!;
    if (t === ATTR_REALM) out.realm = v.toString("utf8");
    off += 4 + l + ((4 - (l % 4)) % 4);
  }
  return out;
}

function judge(kind: ProbeKind, req: Buffer, res: Buffer): ProbeResult {
  const msg = decodeMessage(res);
  if (!msg || !msg.txId.equals(req.subarray(8, 20)))
    return { ok: false, detail: "an answer arrived, but it is not a STUN reply to this request" };
  if (kind === "binding")
    return msg.type === BINDING_SUCCESS
      ? { ok: true, detail: "STUN binding answered" }
      : { ok: false, detail: `unexpected STUN message type 0x${msg.type.toString(16)}` };
  if (msg.type === ALLOCATE_ERROR && msg.errorCode === 401)
    return {
      ok: true,
      detail: `TURN answered (401 as expected without credentials${msg.realm ? `, realm ${msg.realm}` : ""})`,
      errorCode: 401,
      ...(msg.realm ? { realm: msg.realm } : {}),
    };
  return {
    ok: false,
    detail: `a STUN server answered, but not like TURN (type 0x${msg.type.toString(16)}, error ${msg.errorCode ?? "none"})`,
    ...(msg.errorCode ? { errorCode: msg.errorCode } : {}),
  };
}

export function probeUdp(host: string, port: number, kind: ProbeKind, ms = 3000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = encodeRequest(kind);
    const sock = createSocket(host.includes(":") ? "udp6" : "udp4");
    const done = (r: ProbeResult) => {
      clearTimeout(timer);
      sock.close();
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, detail: `no answer from ${host}:${port}/udp within ${ms} ms` }),
      ms,
    );
    sock.on("error", (e) => done({ ok: false, detail: e.message }));
    sock.on("message", (m) => done(judge(kind, req, m)));
    sock.send(req, port, host, (err) => {
      if (err) done({ ok: false, detail: err.message });
    });
  });
}

/** TURN over TLS: `servername` is the name the certificate is checked against (not verified here, see peerCert). */
export function probeTls(
  host: string,
  port: number,
  kind: ProbeKind,
  servername = host,
  ms = 5000,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = encodeRequest(kind);
    let acc = Buffer.alloc(0);
    let finished = false;
    const done = (r: ProbeResult) => {
      if (finished) return;
      finished = true;
      sock.destroy();
      resolve(r);
    };
    const sock = tlsConnect({ host, port, servername, rejectUnauthorized: false, timeout: ms }, () =>
      sock.write(req),
    );
    sock.on("data", (d) => {
      acc = Buffer.concat([acc, d]);
      if (acc.length >= 20 && acc.length >= 20 + acc.readUInt16BE(2)) done(judge(kind, req, acc));
    });
    sock.on("timeout", () =>
      done({ ok: false, detail: `no answer from ${host}:${port}/tls within ${ms} ms` }),
    );
    sock.on("error", (e: Error) => done({ ok: false, detail: e.message }));
    sock.on("close", () => done({ ok: false, detail: `${host}:${port}/tls closed the connection` }));
  });
}
