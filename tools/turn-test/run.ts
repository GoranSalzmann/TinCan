// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Does media really flow through the TURN relay? Joins a LiveKit room from headless Chromium with ICE restricted to
 * relay candidates, and reads which candidate pair the browser selected.
 *
 *   # on the server (prints {url, token, room}; the token lasts 10 minutes and cannot publish):
 *   node apps/server/dist/cli.js voice test-token --url https://chat.example.com > token.json
 *   # on any other machine with this repository built:
 *   pnpm turn-test --token-file token.json [--modes direct,relay,relay-udp,relay-tls]
 *
 * Modes:  direct     no restriction (baseline: expect a host/srflx pair, or tcp)
 *         relay      iceTransportPolicy "relay", every TURN URL LiveKit offers
 *         relay-udp  relay only, TURN URLs over UDP only (3478/udp)
 *         relay-tls  relay only, TURN URLs over TLS only (5349/tcp): what a client behind a UDP-blocking firewall gets.
 *                    The restriction is applied to the ICE configuration, not to the network: it proves the TLS path
 *                    works, not that a particular firewall lets it through.

 * TURN_TLS_PORT=5349 rewrites the advertised turns: port (LiveKit advertises 443, see docs/guides/turn.md §6).
 * Chromium: the one Playwright installed, or CHROMIUM_CHANNEL=chrome|msedge, or CHROMIUM_PATH.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

type Mode = "direct" | "relay" | "relay-udp" | "relay-tls";
const ALL: Mode[] = ["direct", "relay", "relay-udp", "relay-tls"];

interface Outcome {
  mode: Mode;
  connected: boolean;
  candidate?: { type: string; protocol: string; relayProtocol?: string; url?: string; address?: string };
  rttMs?: number;
  /** The ICE server URLs the page saw before filtering. */
  offered?: string[];
  error?: string;
}

const { values } = parseArgs({
  options: {
    "token-file": { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    modes: { type: "string" },
  },
});
const fromFile = values["token-file"]
  ? (JSON.parse(readFileSync(values["token-file"], "utf8").replace("\uFEFF", "")) as {
      url: string;
      token: string;
    })
  : null;
const url = values.url ?? fromFile?.url;
const token = values.token ?? fromFile?.token;
if (!url || !token) {
  console.error(
    "usage: pnpm turn-test --token-file <file from `tincan voice test-token`> [--modes direct,relay,relay-tls]",
  );
  process.exit(2);
}
const modes = (values.modes?.split(",") ?? ALL) as Mode[];
const livekitJs = resolve("apps/web/node_modules/livekit-client/dist/livekit-client.umd.js");

/** Runs in the page before anything else: keeps only the wanted TURN URLs in every RTCPeerConnection. */
const initScript = (mode: Mode): string => `(() => {
  const m = ${JSON.stringify(mode)};
  const Native = window.RTCPeerConnection;
  const keep = (u) =>
    m === "relay-tls" ? u.startsWith("turns:")
    : m === "relay-udp" ? u.startsWith("turn:") && !u.includes("transport=tcp")
    : true;
  // LiveKit advertises its TLS relay on 443 (it expects a load balancer there); TURN_TLS_PORT=5349 points the test at the port Tin Can opens.
  const tlsPort = ${JSON.stringify(process.env.TURN_TLS_PORT ?? "")};
  const retarget = (u) => (tlsPort && u.startsWith("turns:") ? u.replace(/:[0-9]+(?=[?]|$)/, ":" + tlsPort) : u);
  const filter = (cfg) => {
    if (cfg && cfg.iceServers) {
      window.__ice = cfg.iceServers.flatMap((s) => [].concat(s.urls));
      if (m !== "direct" && m !== "relay") {
        cfg = { ...cfg, iceServers: cfg.iceServers
          .map((s) => ({ ...s, urls: [].concat(s.urls).filter(keep).map(retarget) }))
          .filter((s) => s.urls.length > 0) };
      }
    }
    return cfg;
  };
  window.RTCPeerConnection = function (cfg, ...rest) {
    const pc = new Native(filter(cfg), ...rest);
    const set = pc.setConfiguration.bind(pc);
    pc.setConfiguration = (c) => set(filter(c));
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
})()`;

/** Joins the room and reads the nominated candidate pair of the subscriber (or publisher) connection. */
const joinScript = (mode: Mode, u: string, t: string): string => `(async () => {
  const room = new window.LivekitClient.Room({ adaptiveStream: false });
  try {
    await room.connect(${JSON.stringify(u)}, ${JSON.stringify(t)}, ${
      mode === "direct" ? "{}" : '{ rtcConfig: { iceTransportPolicy: "relay" } }'
    });
  } catch (e) {
    return { mode: ${JSON.stringify(mode)}, connected: false, error: String(e), offered: window.__ice };
  }
  await new Promise((r) => setTimeout(r, 3000));
  const pcm = room.engine.pcManager;
  const pc = pcm && (pcm.subscriber || pcm.publisher);
  const report = pc ? await pc.getStats() : null;
  const cands = new Map();
  if (report) report.forEach((s) => { if (s.type === "local-candidate") cands.set(s.id, s); });
  const out = { mode: ${JSON.stringify(mode)}, connected: room.state === "connected" };
  if (report) report.forEach((s) => {
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
      const l = cands.get(s.localCandidateId) || {};
      out.candidate = { type: String(l.candidateType), protocol: String(l.protocol),
        relayProtocol: l.relayProtocol, url: l.url, address: l.address };
      if (typeof s.currentRoundTripTime === "number") out.rttMs = Math.round(s.currentRoundTripTime * 1000);
    }
  });
  out.offered = window.__ice;
  await room.disconnect();
  return out;
})()`;

async function runMode(mode: Mode): Promise<Outcome> {
  const channel = process.env.CHROMIUM_CHANNEL;
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    ...(channel ? { channel } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.addInitScript(initScript(mode));
    await page.goto("about:blank");
    await page.addScriptTag({ path: livekitJs });
    return await page.evaluate<Outcome>(joinScript(mode, url!, token!));
  } finally {
    await browser.close();
  }
}

function verdict(o: Outcome): boolean {
  if (!o.connected || !o.candidate) return false;
  if (o.mode === "direct") return true;
  if (o.candidate.type !== "relay") return false;
  if (o.mode === "relay-tls") return o.candidate.relayProtocol === "tls";
  if (o.mode === "relay-udp") return o.candidate.relayProtocol === "udp";
  return true;
}

let failed = 0;
for (const mode of modes) {
  const o = await runMode(mode).catch((e: Error): Outcome => ({ mode, connected: false, error: e.message }));
  const ok = verdict(o);
  if (!ok) failed++;
  const c = o.candidate;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${mode.padEnd(10)} ${
      o.connected
        ? `connected via ${c ? `${c.type}/${c.relayProtocol ?? c.protocol}${c.url ? ` ${c.url}` : ""}` : "?"}${o.rttMs !== undefined ? `, rtt ${o.rttMs} ms` : ""}`
        : `not connected: ${(o.error ?? "").split("\n")[0]}`
    }`,
  );
  if (!ok && o.offered) console.log(`     ICE servers offered: ${o.offered.join(", ")}`);
}
process.exit(failed ? 1 : 0);
