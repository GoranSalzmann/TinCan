// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";

export const HELPER_URL = "http://127.0.0.1:19477";
const TOKEN_KEY = "tincan.audioHelper.token.v1";
const MODE_KEY = "tincan.audioHelper.mode.v1";

export type HelperErrorCode =
  | "unavailable"
  | "not_paired"
  | "version"
  | "pairing_expired"
  | "popup_blocked"
  | "pipewire_missing"
  | "pipewire_unavailable"
  | "browser_unsupported"
  | "output_missing"
  | "input_missing"
  | "permission_denied"
  | "busy"
  | "source_missing"
  | "select_application"
  | "capture_failed"
  | "session_lost";

const CODES = new Set<string>([
  "not_paired",
  "pipewire_missing",
  "pipewire_unavailable",
  "output_missing",
  "busy",
  "source_missing",
  "select_application",
  "capture_failed",
  "session_lost",
  "pairing_expired",
]);

export class HelperError extends Error {
  constructor(readonly code: HelperErrorCode) {
    super(code);
  }
}

export const helperErrorCode = (error: unknown): HelperErrorCode =>
  error instanceof HelperError ? error.code : "unavailable";

/** Maps a getUserMedia failure to a code; anything else is rethrown unchanged. */
function throwInputError(err: unknown): never {
  if ((err as DOMException).name === "NotAllowedError") throw new HelperError("permission_denied");
  if (["NotFoundError", "OverconstrainedError"].includes((err as DOMException).name))
    throw new HelperError("input_missing");
  throw err;
}

export interface HelperSource {
  id: string;
  name: string;
  detail: string;
  running: boolean;
}

export interface HelperSelection {
  sources: string[];
  names: string[];
}

function saved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* This visit still works without storage. */
  }
}

let token = saved(TOKEN_KEY) ?? "";
export function hasHelperToken(): boolean {
  return token.length > 0;
}
export function helperPreferred(): boolean {
  return saved(MODE_KEY) === "helper";
}
export function preferHelper(on: boolean): void {
  save(MODE_KEY, on ? "helper" : "browser");
}
export function isLinuxDesktop(): boolean {
  return /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
}
export function supportsHelperAudio(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

async function request(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  let result: Response;
  try {
    result = await fetch(`${HELPER_URL}/v1${path}`, {
      ...options,
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.any([AbortSignal.timeout(7000), ...(options.signal ? [options.signal] : [])]),
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new HelperError("unavailable");
  }
  const data: unknown = await result.json().catch(() => null);
  if (!data || typeof data !== "object") throw new HelperError("version");
  const object = data as Record<string, unknown>;
  if (!result.ok || object.error) {
    const code =
      typeof object.error === "string" && CODES.has(object.error)
        ? (object.error as HelperErrorCode)
        : "unavailable";
    if (code === "not_paired") {
      token = "";
      save(TOKEN_KEY, "");
    }
    throw new HelperError(code);
  }
  return object;
}

export async function checkHelper(signal?: AbortSignal): Promise<void> {
  const status = await request("/status", { signal });
  if (status.name !== "tincan-audio" || status.protocol !== 1) throw new HelperError("version");
}

function parseSources(value: unknown): HelperSource[] {
  if (!Array.isArray(value) || value.length > 4096) throw new HelperError("version");
  return value.filter((s: unknown): s is HelperSource => {
    if (!s || typeof s !== "object") return false;
    const v = s as Record<string, unknown>;
    return (
      typeof v.id === "string" &&
      /^\d+$/.test(v.id) &&
      typeof v.name === "string" &&
      typeof v.detail === "string" &&
      typeof v.running === "boolean"
    );
  });
}

export async function helperSources(signal?: AbortSignal): Promise<HelperSource[]> {
  return parseSources((await request("/sources", { signal })).sources);
}

const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

/** A local page confirms the exact site. Polling works even when COOP severs the popup's opener. */
export async function pairHelper(signal: AbortSignal): Promise<void> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const url = new URL("/connect", HELPER_URL);
  url.searchParams.set("origin", location.origin);
  url.searchParams.set("challenge", challenge);
  // Must happen synchronously in the button's click handler, before an await.
  const popup = window.open(url.href, "_blank");
  if (!popup) throw new HelperError("popup_blocked");
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    await pause(1000, signal);
    try {
      const result = await request("/pair", { method: "POST", body: JSON.stringify({ challenge }), signal });
      if (typeof result.token === "string" && /^[a-f0-9]{64}$/.test(result.token) && result.protocol === 1) {
        token = result.token;
        save(TOKEN_KEY, token);
        return;
      }
    } catch (err) {
      // The first poll may beat the new tab's GET /connect.
      if (!(err instanceof HelperError && err.code === "pairing_expired")) throw err;
    }
  }
  throw new HelperError("pairing_expired");
}

export const useHelperAudio = create<{
  active: boolean;
  level: number;
  names: string[];
  missing: boolean;
}>(() => ({ active: false, level: 0, names: [], missing: false }));

export interface HelperCapture {
  track: MediaStreamTrack;
  stop: () => Promise<void>;
}

type RoutedContext = AudioContext & {
  sinkId?: string | { type: "none" };
  setSinkId: (id: string) => Promise<void>;
};

/**
 * Owns all native and browser resources. Routing the call is mandatory before
 * capture starts. There is never a fallback to the default microphone.
 */
export async function captureHelperAudio(
  selection: HelperSelection,
  playback: AudioContext,
  outputDeviceId: string | null,
  signal: AbortSignal,
  onLost: (code: HelperErrorCode) => void,
): Promise<HelperCapture> {
  if (!supportsHelperAudio()) throw new HelperError("browser_unsupported");
  const context = playback as RoutedContext;
  const previousOutput = typeof context.sinkId === "string" ? context.sinkId : (outputDeviceId ?? "");
  // Device labels are empty until a getUserMedia grant, so listen-only users
  // unlock them here before the saved output's label is resolved. This stream
  // is used solely for enumeration and is immediately stopped.
  let before = await navigator.mediaDevices.enumerateDevices();
  signal.throwIfAborted();
  if (!before.some((d) => d.label)) {
    try {
      const permission = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      permission.getTracks().forEach((t) => t.stop());
    } catch (err) {
      throwInputError(err);
    }
    signal.throwIfAborted();
    before = await navigator.mediaDevices.enumerateDevices();
  }
  const outputLabel =
    outputDeviceId && outputDeviceId !== "default"
      ? before.find((d) => d.kind === "audiooutput" && d.deviceId === outputDeviceId)?.label
      : "";
  if (outputDeviceId && outputDeviceId !== "default" && !outputLabel) throw new HelperError("output_missing");
  const description = await request("/session", {
    // Read the session ID even if cancelled meanwhile, so we can delete it.
    method: "POST",
    body: JSON.stringify({ outputLabel: outputLabel ?? "" }),
  });
  if (
    typeof description.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(description.id) ||
    typeof description.sourceLabel !== "string" ||
    typeof description.outputLabel !== "string"
  ) {
    throw new HelperError("version");
  }
  const path = `/session/${description.id}`;
  const watchAbort = new AbortController();
  let closed = false;
  let cleanup: Promise<void> | null = null;
  let stream: MediaStream | null = null;
  let routed = false;
  let meter: ReturnType<typeof setInterval> | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let silence: GainNode | null = null;
  let lost: HelperErrorCode | null = null;
  let delivered = false;
  let ready: () => void = () => undefined;
  const watching = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const watchDeadline = setTimeout(() => {
    if (!closed) fail("session_lost");
  }, 7000);
  const fail = (code: HelperErrorCode) => {
    if (closed) return;
    lost = code;
    stream?.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    void stop();
    if (delivered) onLost(code);
  };
  let protectedOutput = "";
  const sinkChanged = () => {
    if (!closed && protectedOutput && context.sinkId !== protectedOutput) {
      // Stop the outgoing samples synchronously, before doing network cleanup.
      fail("output_missing");
    }
  };

  const stop = (): Promise<void> =>
    (cleanup ??= (async () => {
      closed = true;
      clearTimeout(watchDeadline);
      ready();
      signal.removeEventListener("abort", abort);
      context.removeEventListener("sinkchange", sinkChanged);
      if (meter) clearInterval(meter);
      stream?.getTracks().forEach((t) => t.stop());
      source?.disconnect();
      analyser?.disconnect();
      silence?.disconnect();
      useHelperAudio.setState({ active: false, level: 0, names: [], missing: false });
      // Restore hearing BEFORE removing the temporary sink.
      if (routed && context.state !== "closed") {
        await context
          .setSinkId(previousOutput)
          .catch(() => context.setSinkId(""))
          .catch(() => undefined);
      }
      watchAbort.abort();
      await request(path, { method: "DELETE", keepalive: true }).catch(() => undefined);
    })());
  const abort = () => {
    void stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  const assertAlive = () => {
    if (lost) throw new HelperError(lost);
    if (closed || signal.aborted) throw new DOMException("Cancelled", "AbortError");
  };

  const watch = async () => {
    try {
      const response = await fetch(`${HELPER_URL}/v1${path}/watch`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
        signal: watchAbort.signal,
      });
      if (!response.ok || !response.body) throw new HelperError("session_lost");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new HelperError("session_lost");
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 1_000_000) throw new HelperError("version");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const event = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          buffer = buffer.slice(newline + 1);
          if (event.error)
            throw new HelperError(
              typeof event.error === "string" && CODES.has(event.error)
                ? (event.error as HelperErrorCode)
                : "session_lost",
            );
          const current = parseSources(event.sources);
          clearTimeout(watchDeadline);
          ready();
          useHelperAudio.setState({
            missing: selection.sources.some((id) => !current.some((s) => s.id === id)),
          });
        }
      }
    } catch (err) {
      if (closed) return;
      fail(helperErrorCode(err));
    }
  };
  void watch();
  try {
    assertAlive();
    let input: MediaDeviceInfo | undefined;
    let output: MediaDeviceInfo | undefined;
    const deadline = Date.now() + 6000;
    do {
      assertAlive();
      const devices = await navigator.mediaDevices.enumerateDevices();
      input = devices.find((d) => d.kind === "audioinput" && d.label === description.sourceLabel);
      output = devices.find((d) => d.kind === "audiooutput" && d.label === description.outputLabel);
      if (input && output) break;
      await pause(150, signal);
    } while (Date.now() < deadline);
    if (!input) throw new HelperError("input_missing");
    if (!output) throw new HelperError("output_missing");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: input.deviceId },
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    assertAlive();
    await context.setSinkId(output.deviceId).catch(() => {
      throw new HelperError("output_missing");
    });
    routed = true;
    protectedOutput = output.deviceId;
    context.addEventListener("sinkchange", sinkChanged);
    assertAlive();
    await watching;
    assertAlive();
    await request(`${path}/start`, {
      method: "POST",
      body: JSON.stringify({ sources: selection.sources }),
      signal,
    });
    assertAlive();
    const track = stream.getAudioTracks()[0];
    if (!track) throw new HelperError("input_missing");
    track.addEventListener(
      "ended",
      () => {
        fail("input_missing");
      },
      { once: true },
    );
    source = playback.createMediaStreamSource(stream);
    analyser = playback.createAnalyser();
    analyser.fftSize = 256;
    silence = playback.createGain();
    silence.gain.value = 0;
    source.connect(analyser).connect(silence).connect(playback.destination);
    const samples = new Float32Array(analyser.fftSize);
    meter = setInterval(() => {
      analyser!.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
      useHelperAudio.setState({ level: Math.min(1, rms * 4) });
    }, 100);
    useHelperAudio.setState({ active: true, names: selection.names });
    delivered = true;
    return { track, stop };
  } catch (err) {
    // A pending getUserMedia or setSinkId can resolve after cancellation. Repeat
    // local cleanup here, even if the abort handler already closed the session.
    stream?.getTracks().forEach((track) => track.stop());
    context.removeEventListener("sinkchange", sinkChanged);
    if (routed && closed && context.state !== "closed") {
      await context
        .setSinkId(previousOutput)
        .catch(() => context.setSinkId(""))
        .catch(() => undefined);
    }
    await stop();
    throwInputError(err);
  }
}
