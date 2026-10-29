// SPDX-License-Identifier: AGPL-3.0-or-later
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { RoomServiceClient } from "livekit-server-sdk";
import type { CoreConfig } from "../config/schema.js";
import type { CheckResult } from "./doctor.js";

/**
 * Voice and network checks for `tincan doctor` (14 §9, 08 §10). Everything here runs from the machine the
 * CLI is on. A check from the inside cannot prove that the outside can reach a port, so those checks say what
 * they did prove and print the command to run from another machine (14 §3).
 */

/** The compose file hands the app `host.docker.internal`; on the host that name is not resolvable, loopback is. */
export function apiUrlOnHost(apiUrl: string): string {
  return apiUrl.replace("://host.docker.internal", "://127.0.0.1");
}

export function certDaysLeft(validTo: string, now = Date.now()): number {
  return Math.floor((Date.parse(validTo) - now) / 86_400_000);
}

export type TurnReload = "none" | "wait" | "restart";

/**
 * 18 T30: LiveKit reads the TURN certificate only at start, so a renewed certificate takes effect after a restart,
 * which drops every call. Restart only when no room is active, or, if rooms never empty, once the certificate LiveKit
 * serves is within `deadlineDays` of expiring.
 */
export function decideTurnReload(input: {
  servedFingerprint: string;
  currentFingerprint: string;
  servedDaysLeft: number;
  activeRooms: number;
  deadlineDays?: number;
}): TurnReload {
  if (input.servedFingerprint === input.currentFingerprint) return "none";
  if (input.activeRooms === 0) return "restart";
  return input.servedDaysLeft <= (input.deadlineDays ?? 7) ? "restart" : "wait";
}

function peerCert(host: string, port: number, servername: string, ms = 5000): Promise<PeerCertificate> {
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host, port, servername, rejectUnauthorized: false, timeout: ms }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (cert?.valid_to) resolve(cert);
      else reject(new Error("no certificate presented"));
    });
    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error(`no TLS answer within ${ms} ms`));
    });
    sock.on("error", reject);
  });
}

function tcpOpen(host: string, port: number, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = tcpConnect({ host, port, timeout: ms });
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => resolve(false));
  });
}

async function check(name: string, fn: () => Promise<Omit<CheckResult, "name">>): Promise<CheckResult> {
  try {
    return { name, ...(await fn()) };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

export interface VoiceCheckOptions {
  /** Public URL of the instance (for the blocked-webhook-path check). */
  url: string;
  /** Hostname of the TURN name, when TURN is configured. */
  turnDomain?: string;
}

export async function runVoiceChecks(config: CoreConfig, opts: VoiceCheckOptions): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const lk = config.livekit;
  if (!lk) {
    return [
      "Voice server reachable",
      "Webhook path",
      "Voice media ports",
      "Relay (TURN/TLS 5349)",
      "Public IP matches",
    ].map((name) => ({
      name,
      status: "skip" as const,
      detail: "no livekit: section in the configuration; voice is off",
    }));
  }
  const api = apiUrlOnHost(lk.apiUrl);
  const host = new URL(opts.url).hostname;

  out.push(
    await check("Voice server reachable", async () => {
      const rooms = await new RoomServiceClient(api, lk.apiKey, lk.apiSecret).listRooms();
      return { status: "ok", detail: `LiveKit API answered at ${api} (${rooms.length} active room(s))` };
    }).then((r) =>
      r.status === "fail"
        ? {
            ...r,
            detail: `${api}: ${r.detail}`,
            fix: "start it with `docker compose --profile voice up -d`; check `docker compose logs livekit` and that the key and secret in .env match livekit.yaml",
          }
        : r,
    ),
  );

  // The webhook must reach the app (loopback) and must not be reachable from outside (18 T5, T26).
  out.push(
    await check("Webhook path", async () => {
      const local = `http://127.0.0.1:${config.server.port}/api/v1/internal/livekit/webhook`;
      const mine = await fetch(local, {
        method: "POST",
        headers: { "content-type": "application/webhook+json" },
        body: "{}",
      });
      if (mine.status !== 401)
        throw new Error(`the app answered ${mine.status} at ${local}; expected 401 (signature required)`);
      if (opts.url.startsWith("https://")) {
        const pub = await fetch(`${opts.url}/api/v1/internal/livekit/webhook`, {
          method: "POST",
          body: "{}",
        });
        if (pub.status !== 404) {
          return {
            status: "fail" as const,
            detail: `the public URL answered ${pub.status} for the internal webhook path`,
            fix: "the Caddyfile must answer 404 for /api/internal/* and /api/v1/internal/* (18 T26)",
          };
        }
      }
      return {
        status: "ok" as const,
        detail: "reachable on loopback with signature check; blocked on the public URL",
      };
    }),
  );

  const ips = await lookup(host, { all: true }).catch(() => []);
  out.push(
    await check("Voice media ports", async () => {
      if (ips.length === 0) return { status: "skip", detail: `${host} does not resolve; fix DNS first` };
      const tcp = await tcpOpen(ips[0]!.address, 7881);
      const detail = tcp
        ? "TCP 7881 accepts connections on this machine's public name"
        : "TCP 7881 does not answer on this machine's public name";
      return {
        status: tcp ? "warn" : "fail",
        detail: `${detail}. UDP 7882 cannot be probed from here.`,
        fix: `from ANOTHER machine run: nc -vz ${host} 7881 ; and for UDP: nc -vzu ${host} 7882 (UDP "open" only means not rejected). The decisive test is Settings → Voice → Test connection in the web app. Open 7881/tcp and 7882/udp in the host firewall and the provider's firewall (14 §3).`,
      };
    }),
  );

  out.push(
    await check("Relay (TURN/TLS 5349)", async () => {
      const domain = opts.turnDomain ?? process.env.TURN_DOMAIN;
      if (!domain) {
        return {
          status: "skip",
          detail: "TURN is not configured (turn: enabled: false)",
          fix: "set it up with a second DNS name: see the staging runbook in docs/qa/m3.md",
        };
      }
      const cert = await peerCert(domain, 5349, domain);
      const left = certDaysLeft(cert.valid_to);
      const name = cert.subjectaltname?.includes(domain) || cert.subject?.CN === domain;
      if (!name)
        return {
          status: "fail",
          detail: `the certificate on 5349 is not for ${domain}`,
          fix: "restart LiveKit after Caddy has issued the certificate",
        };
      if (left < 0)
        return {
          status: "fail",
          detail: `the certificate on 5349 expired ${-left} day(s) ago`,
          fix: "restart LiveKit with `tincan voice turn-reload --apply`",
        };
      return {
        status: left < 14 ? "warn" : "ok",
        detail: `TLS answers on ${domain}:5349, certificate valid for ${left} more day(s)`,
        ...(left < 14
          ? { fix: "run `tincan voice turn-reload` (restarts LiveKit when no room is active, 18 T30)" }
          : {}),
      };
    }),
  );

  out.push(
    await check("Public IP matches", async () => {
      if (ips.length === 0) return { status: "skip", detail: `${host} does not resolve` };
      const local = new Set(
        Object.values(networkInterfaces())
          .flat()
          .filter((i) => i && !i.internal)
          .map((i) => i!.address),
      );
      const dns = ips.map((i) => i.address);
      if (dns.some((a) => local.has(a)))
        return { status: "ok", detail: `${host} → ${dns.join(", ")} is an address of this machine` };
      return {
        status: "warn",
        detail: `${host} → ${dns.join(", ")}, none of which is configured on this machine's interfaces`,
        fix: "normal on clouds that NAT a public IP (AWS, GCP, Oracle). Otherwise this may be CGNAT or a wrong DNS record: voice needs a public IPv4 that reaches this machine, or set rtc.node_ip in livekit.yaml (14 §1)",
      };
    }),
  );
  return out;
}

export interface TurnReloadReport {
  decision: TurnReload;
  lines: string[];
}

/**
 * `tincan voice turn-reload`: compares the certificate LiveKit serves on 5349 with the one Caddy now serves for the
 * same name on 443, and decides whether a restart is due (18 T30). The caller restarts LiveKit only with `--apply`.
 */
export async function turnReloadReport(config: CoreConfig, turnDomain: string): Promise<TurnReloadReport> {
  const lk = config.livekit;
  if (!lk) throw new Error("no livekit: section in the configuration");
  const served = await peerCert(turnDomain, 5349, turnDomain);
  const current = await peerCert(turnDomain, 443, turnDomain);
  const rooms = await new RoomServiceClient(apiUrlOnHost(lk.apiUrl), lk.apiKey, lk.apiSecret).listRooms();
  const decision = decideTurnReload({
    servedFingerprint: served.fingerprint256,
    currentFingerprint: current.fingerprint256,
    servedDaysLeft: certDaysLeft(served.valid_to),
    activeRooms: rooms.filter((r) => r.numParticipants > 0).length,
  });
  return {
    decision,
    lines: [
      `LiveKit serves a certificate valid for ${certDaysLeft(served.valid_to)} more day(s) on ${turnDomain}:5349`,
      `Caddy serves one valid for ${certDaysLeft(current.valid_to)} more day(s) on ${turnDomain}:443`,
      `${rooms.filter((r) => r.numParticipants > 0).length} room(s) with people in them`,
      decision === "none"
        ? "Same certificate: nothing to do."
        : decision === "wait"
          ? "A renewed certificate is waiting, but a call is running: not restarting now. Try again later."
          : "Restart is due.",
    ],
  };
}
