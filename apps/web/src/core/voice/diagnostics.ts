// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Room } from "livekit-client";
import { api, request } from "../api/client.js";

export type Transport = "udp" | "tcp" | "relay";
export type StepId = "server" | "mic" | "udp" | "tcp" | "relay";
export type StepState = "wait" | "run" | "ok" | "fail" | "skip";

export interface Step {
  state: StepState;
  detail?: string;
}

export type Summary = "udp" | "tcp" | "relay" | "none" | "off";

export interface Report {
  steps: Record<StepId, Step>;
  transport: Transport | null;
  rttMs: number | null;
  lossPct: number | null;
  summary: Summary | null;
}

export const STEP_ORDER: StepId[] = ["server", "mic", "udp", "tcp", "relay"];

export const emptyReport = (): Report => ({
  steps: {
    server: { state: "wait" },
    mic: { state: "wait" },
    udp: { state: "wait" },
    tcp: { state: "wait" },
    relay: { state: "wait" },
  },
  transport: null,
  rttMs: null,
  lossPct: null,
  summary: null,
});

/** Which path did the media end up on, and how good is it (08 §10)? Reads the nominated ICE pair and its RTT. */
export async function selectedTransport(
  room: Room,
): Promise<{ transport: Transport; rttMs: number | null } | null> {
  const pc = room.engine.pcManager?.publisher ?? room.engine.pcManager?.subscriber;
  const report = await pc?.getStats();
  if (!report) return null;
  const cands = new Map<string, Record<string, unknown>>();
  report.forEach((s: Record<string, unknown>) => {
    if (s.type === "local-candidate") cands.set(String(s.id), s);
  });
  let found: { transport: Transport; rttMs: number | null } | null = null;
  report.forEach((s: Record<string, unknown>) => {
    if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
      const l = cands.get(String(s.localCandidateId));
      found = {
        transport: l?.candidateType === "relay" ? "relay" : l?.protocol === "tcp" ? "tcp" : "udp",
        rttMs: typeof s.currentRoundTripTime === "number" ? Math.round(s.currentRoundTripTime * 1000) : null,
      };
    }
  });
  return found;
}

/** Decides the plain-language summary from which steps passed (W-25). */
export function summarise(steps: Record<StepId, Step>, transport: Transport | null): Summary {
  if (transport) return transport;
  if (steps.relay.state === "ok") return "relay";
  return "none";
}

async function connectOnce(
  relayOnly: boolean,
): Promise<{ transport: Transport | null; rttMs: number | null; lossPct: number | null } | null> {
  const { Room } = await import("livekit-client");
  const grant = await request<{ url: string; token: string }>("POST", "/voice/diagnostics");
  const room = new Room({ adaptiveStream: false, dynacast: false });
  try {
    await room.connect(grant.url, grant.token, {
      autoSubscribe: false,
      peerConnectionTimeout: 8000,
      ...(relayOnly ? { rtcConfig: { iceTransportPolicy: "relay" } } : {}),
    });
    await new Promise((r) => setTimeout(r, 1500));
    const sel = await selectedTransport(room);
    return { transport: sel?.transport ?? null, rttMs: sel?.rttMs ?? null, lossPct: 0 };
  } catch {
    return null;
  } finally {
    await room.disconnect().catch(() => undefined);
  }
}

/**
 * The connection test of W-25. A browser cannot ask "is UDP blocked?" directly, so each path is judged from where a real
 * connection ended up: a normal attempt (UDP if it can, then TCP, then relay by the ICE rules), then a relay-only attempt.
 * It joins a private listen-only room, not a voice channel, so nobody sees it.
 */
export async function runConnectionTest(onUpdate: (r: Report) => void): Promise<Report> {
  const r = emptyReport();
  const set = (id: StepId, step: Step) => {
    r.steps[id] = step;
    onUpdate({ ...r, steps: { ...r.steps } });
  };

  set("server", { state: "run" });
  try {
    const caps = await api.capabilities();
    if (!caps.features.voice) {
      set("server", { state: "ok", detail: "voice off" });
      r.summary = "off";
      for (const id of ["mic", "udp", "tcp", "relay"] as StepId[]) set(id, { state: "skip" });
      return r;
    }
    set("server", { state: "ok" });
  } catch (e) {
    set("server", { state: "fail", detail: (e as Error).message });
    r.summary = "none";
    for (const id of ["mic", "udp", "tcp", "relay"] as StepId[]) set(id, { state: "skip" });
    return r;
  }

  set("mic", { state: "run" });
  try {
    const state = await navigator.permissions
      ?.query({ name: "microphone" })
      .then((p) => p.state)
      .catch(() => "prompt");
    set(
      "mic",
      state === "denied"
        ? { state: "fail", detail: "denied" }
        : { state: "ok", detail: state === "granted" ? undefined : "will ask when you join" },
    );
  } catch {
    set("mic", { state: "skip" });
  }

  set("udp", { state: "run" });
  const first = await connectOnce(false);
  if (first?.transport) {
    r.transport = first.transport;
    r.rttMs = first.rttMs;
    r.lossPct = first.lossPct;
    set("udp", first.transport === "udp" ? { state: "ok" } : { state: "fail", detail: "blocked" });
    set(
      "tcp",
      first.transport === "tcp"
        ? { state: "ok" }
        : first.transport === "udp"
          ? { state: "skip", detail: "not needed" }
          : { state: "fail" },
    );
    if (first.transport === "relay") set("relay", { state: "ok" });
  } else {
    set("udp", { state: "fail", detail: "blocked" });
    set("tcp", { state: "fail" });
  }
  if (r.steps.relay.state === "wait") {
    set("relay", { state: "run" });
    const relay = await connectOnce(true);
    set(
      "relay",
      relay?.transport === "relay"
        ? { state: "ok" }
        : { state: "fail", detail: relay ? "not available" : "blocked" },
    );
  }
  r.summary = summarise(r.steps, r.transport);
  onUpdate({ ...r, steps: { ...r.steps } });
  return r;
}

/** Plain text for "Copy diagnostics": technical details, nothing that identifies the person (W-25). */
export function diagnosticsText(r: Report): string {
  const lines = [
    `Tin Can connection test, ${new Date().toISOString()}`,
    `user agent: ${navigator.userAgent}`,
    ...STEP_ORDER.map(
      (id) => `${id}: ${r.steps[id].state}${r.steps[id].detail ? ` (${r.steps[id].detail})` : ""}`,
    ),
    `selected transport: ${r.transport ?? "none"}`,
    `rtt ms: ${r.rttMs ?? "n/a"}`,
    `summary: ${r.summary ?? "n/a"}`,
  ];
  return lines.join("\n");
}
