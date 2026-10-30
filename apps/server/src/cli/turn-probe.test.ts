// SPDX-License-Identifier: AGPL-3.0-or-later
import { createSocket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { decodeMessage, encodeRequest, probeUdp } from "./turn-probe.js";

function reply(req: Buffer, type: number, attrs: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(attrs.length, 2);
  req.copy(head, 4, 4, 20); // cookie and transaction id
  return Buffer.concat([head, attrs]);
}

const error401 = Buffer.concat([
  Buffer.from([0, 9, 0, 8, 0, 0, 4, 1]),
  Buffer.from("Unauthorized".slice(0, 4)),
]);

const sockets: ReturnType<typeof createSocket>[] = [];
async function fakeServer(answer: (req: Buffer) => Buffer | null): Promise<number> {
  const s = createSocket("udp4");
  sockets.push(s);
  s.on("message", (m, r) => {
    const a = answer(m);
    if (a) s.send(a, r.port, r.address);
  });
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", r));
  return s.address().port;
}
afterEach(() => sockets.splice(0).forEach((s) => s.close()));

describe("STUN/TURN probe", () => {
  it("encodes an Allocate request that asks for a UDP relay", () => {
    const m = encodeRequest("allocate", Buffer.alloc(12, 7));
    expect(m.readUInt16BE(0)).toBe(0x0003);
    expect(m.readUInt32BE(4)).toBe(0x2112a442);
    expect(m.subarray(20)).toEqual(Buffer.from([0, 0x19, 0, 4, 17, 0, 0, 0]));
    expect(decodeMessage(m)?.type).toBe(0x0003);
  });

  it("reads the error code and ignores truncated or foreign data", () => {
    const req = encodeRequest("allocate");
    expect(decodeMessage(reply(req, 0x0113, error401))?.errorCode).toBe(401);
    expect(decodeMessage(Buffer.from("not stun at all, definitely not"))).toBeNull();
    expect(decodeMessage(reply(req, 0x0113, error401).subarray(0, 24))).toBeNull();
  });

  it("accepts a 401 to Allocate as a working TURN server", async () => {
    const port = await fakeServer((req) => reply(req, 0x0113, error401));
    const r = await probeUdp("127.0.0.1", port, "allocate", 1000);
    expect(r).toMatchObject({ ok: true, errorCode: 401 });
  });

  it("rejects a plain STUN server that does not speak TURN", async () => {
    const port = await fakeServer((req) => reply(req, 0x0101, Buffer.alloc(0)));
    const r = await probeUdp("127.0.0.1", port, "allocate", 1000);
    expect(r.ok).toBe(false);
  });

  it("reports silence as a failure with the port in the message", async () => {
    const port = await fakeServer(() => null);
    const r = await probeUdp("127.0.0.1", port, "binding", 200);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(`${port}/udp`);
  });

  it("ignores an answer to a different transaction", async () => {
    const port = await fakeServer((req) => {
      const bad = Buffer.from(req);
      bad[10] ^= 0xff;
      return reply(bad, 0x0113, error401);
    });
    expect((await probeUdp("127.0.0.1", port, "allocate", 1000)).ok).toBe(false);
  });
});
