// SPDX-License-Identifier: AGPL-3.0-or-later
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { isPublicAddress } from "./ip.js";

export type FetchFailure =
  "blocked" | "timeout" | "too_large" | "bad_type" | "status" | "redirects" | "network";

export class FetchError extends Error {
  constructor(
    readonly reason: FetchFailure,
    message: string,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** What the fetcher asks of the network; tests replace it, production uses `defaultNetwork`. */
export interface FetchNetwork {
  /** Every address a host name resolves to. */
  resolve(host: string): Promise<string[]>;
  allowAddress(ip: string): boolean;
  allowedPorts: ReadonlySet<number>;
}

export const defaultNetwork: FetchNetwork = {
  async resolve(host) {
    const all = await dnsLookup(host, { all: true, verbatim: true });
    return all.map((a) => a.address);
  },
  allowAddress: isPublicAddress,
  allowedPorts: new Set([80, 443]),
};

export interface FetchLimits {
  /** Bytes read from the body. */
  maxBytes: number;
  /** What happens when the body is longer: keep the start (HTML) or give up (JSON, images). */
  onLimit: "truncate" | "fail";
  /** The whole fetch, redirects included. */
  timeoutMs: number;
  maxRedirects: number;
  accept: string;
  /** Allowed `Content-Type` values (the part before `;`). */
  types: readonly string[];
}

export interface FetchResult {
  finalUrl: string;
  contentType: string;
  /** The `charset` of the content type, if any. */
  charset: string | null;
  body: Buffer;
  truncated: boolean;
}

/** The hostname of a URL without IPv6 brackets. */
const hostOf = (u: URL): string => (u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname);

/** Checks scheme, credentials and port, resolves the name, and returns the one address to connect to. */
async function vet(u: URL, net: FetchNetwork): Promise<string> {
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new FetchError("blocked", "only http and https");
  if (u.username || u.password) throw new FetchError("blocked", "credentials in the address");
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!net.allowedPorts.has(port)) throw new FetchError("blocked", "port not allowed");
  const host = hostOf(u);
  if (!host) throw new FetchError("blocked", "no host");
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = await net.resolve(host);
    } catch {
      throw new FetchError("network", "the name did not resolve");
    }
  }
  if (addrs.length === 0) throw new FetchError("network", "the name did not resolve");
  // One bad answer rejects the host: a name that also points inside must never be fetched.
  if (!addrs.every((a) => net.allowAddress(a))) throw new FetchError("blocked", "address not allowed");
  return addrs[0]!;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

type Hop = { redirect: string } | { result: Omit<FetchResult, "finalUrl"> };

/**
 * GET a URL on behalf of the server without letting the URL steer the server into its own network (15 §4.3).
 * Every hop is vetted and the connection goes to the vetted IP, so the address cannot change between the check and
 * the connection. No cookies or credentials are sent, the body is not decompressed, and time and size are capped.
 */
export async function safeFetch(
  url: string,
  limits: FetchLimits,
  net: FetchNetwork,
  userAgent: string,
): Promise<FetchResult> {
  const deadline = Date.now() + limits.timeoutMs;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new FetchError("blocked", "not a URL");
  }
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const ip = await vet(current, net);
    const res = await request(current, ip, limits, deadline, userAgent);
    if ("redirect" in res) {
      try {
        current = new URL(res.redirect, current);
      } catch {
        throw new FetchError("blocked", "bad redirect");
      }
      continue;
    }
    return { ...res.result, finalUrl: current.href };
  }
  throw new FetchError("redirects", "too many redirects");
}

function request(u: URL, ip: string, limits: FetchLimits, deadline: number, userAgent: string): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new FetchError("timeout", "out of time"));
    const secure = u.protocol === "https:";
    const host = hostOf(u);
    const mod = secure ? https : http;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = mod.request(
      {
        host: ip,
        port: u.port ? Number(u.port) : secure ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        agent: false,
        setHost: false,
        // The name is still what the certificate must match.
        ...(secure && !isIP(host) ? { servername: host } : {}),
        headers: {
          Host: u.host,
          "User-Agent": userAgent,
          Accept: limits.accept,
          "Accept-Encoding": "identity",
          Connection: "close",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (REDIRECTS.has(status) && res.headers.location) {
          res.resume();
          return done(() => resolve({ redirect: res.headers.location! }));
        }
        if (status !== 200) {
          res.destroy();
          return done(() => reject(new FetchError("status", `status ${status}`)));
        }
        const rawType = res.headers["content-type"] ?? "";
        const contentType = rawType.split(";")[0]!.trim().toLowerCase();
        const charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(rawType)?.[1]?.toLowerCase() ?? null;
        if (!limits.types.includes(contentType)) {
          res.destroy();
          return done(() => reject(new FetchError("bad_type", `type ${contentType || "none"}`)));
        }
        const declared = Number(res.headers["content-length"]);
        if (limits.onLimit === "fail" && Number.isFinite(declared) && declared > limits.maxBytes) {
          res.destroy();
          return done(() => reject(new FetchError("too_large", "body too large")));
        }
        const chunks: Buffer[] = [];
        let got = 0;
        res.on("data", (c: Buffer) => {
          const room = limits.maxBytes - got;
          if (c.length > room) {
            if (limits.onLimit === "fail") {
              res.destroy();
              return done(() => reject(new FetchError("too_large", "body too large")));
            }
            chunks.push(c.subarray(0, room));
            res.destroy();
            return done(() =>
              resolve({ result: { contentType, charset, body: Buffer.concat(chunks), truncated: true } }),
            );
          }
          chunks.push(c);
          got += c.length;
        });
        res.on("end", () =>
          done(() =>
            resolve({ result: { contentType, charset, body: Buffer.concat(chunks), truncated: false } }),
          ),
        );
        res.on("error", () => done(() => reject(new FetchError("network", "connection lost"))));
        res.on("close", () => done(() => reject(new FetchError("network", "connection closed"))));
      },
    );
    // One timer for the whole exchange, so a server that dribbles bytes cannot hold the connection open.
    timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new FetchError("timeout", "too slow")));
    }, left);
    req.on("error", () => done(() => reject(new FetchError("network", "could not connect"))));
    req.end();
  });
}
