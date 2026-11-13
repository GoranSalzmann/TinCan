// SPDX-License-Identifier: AGPL-3.0-or-later
import { isIP } from "node:net";

/** [network, prefix length] pairs of IPv4 space that is not the public internet (23 §8.3). */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including the cloud metadata address
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and 255.255.255.255
];

function v4ToInt(a: string): number | null {
  const p = a.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4(n: number, base: string, prefix: number): boolean {
  const b = v4ToInt(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (n & mask) >>> 0 === (b & mask) >>> 0;
}

/** The 16 bytes of an IPv6 address, or null if it is not one. Handles `::` and a dotted IPv4 tail. */
export function ipv6Bytes(addr: string): Uint8Array | null {
  let a = addr.toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (isIP(a) !== 6) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (tail) {
    const n = v4ToInt(tail[1]!);
    if (n === null) return null;
    a =
      a.slice(0, a.length - tail[1]!.length) +
      ((n >>> 16) & 0xffff).toString(16) +
      ":" +
      (n & 0xffff).toString(16);
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] ?? "", 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

const v4Of = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

function publicV4(n: number): boolean {
  return !BLOCKED_V4.some(([base, prefix]) => inV4(n, base, prefix));
}

/**
 * True only for an address on the public internet. IPv6 is allow-listed (global unicast 2000::/3 minus documentation
 * and tunnelling ranges); addresses that wrap an IPv4 one (v4-mapped, NAT64, 6to4) are judged by the IPv4 inside.
 */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.startsWith("[") ? ip.slice(1, -1) : ip;
  const kind = isIP(bare);
  if (kind === 4) {
    const n = v4ToInt(bare);
    return n !== null && publicV4(n);
  }
  if (kind !== 6) return false;
  const b = ipv6Bytes(bare);
  if (!b) return false;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (v4-mapped) and ::a.b.c.d (deprecated v4-compatible, which also covers :: and ::1).
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return publicV4(v4Of(b, 12));
  if (zeros(0, 12)) return false;
  // 64:ff9b::/96 (NAT64): judged by the embedded IPv4. 64:ff9b:1::/48 is local-use.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return zeros(4, 12) ? publicV4(v4Of(b, 12)) : false;
  }
  // 2002::/16 (6to4): judged by the embedded IPv4.
  if (b[0] === 0x20 && b[1] === 0x02) return publicV4(v4Of(b, 2));
  if ((b[0]! & 0xe0) !== 0x20) return false; // outside 2000::/3: unique-local, link-local, multicast, discard …
  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0 && b[3] === 0) return false; // 2001::/32 Teredo
    if (b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32 documentation
    if (b[2] === 0 && (b[3]! & 0xf0) === 0x10) return false; // 2001:10::/28 ORCHID
  }
  if (b[0] === 0x3f && b[1] === 0xff && (b[2]! & 0xf0) === 0) return false; // 3fff::/20 documentation
  return true;
}
