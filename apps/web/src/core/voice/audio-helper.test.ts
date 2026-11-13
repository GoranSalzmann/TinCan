// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureHelperAudio, HelperError, useHelperAudio } from "./audio-helper.js";

const id = "a".repeat(64);
const selection = { sources: ["101"], names: ["Game"] };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const device = (kind: MediaDeviceKind, deviceId: string, label: string) =>
  ({ kind, deviceId, label, groupId: "" }) as MediaDeviceInfo;
const devices = [
  device("audioinput", "mic", "Microphone"),
  device("audioinput", "helper-input", "Tin Can Stream aaaaaaaa"),
  device("audiooutput", "speakers", "Speakers"),
  device("audiooutput", "helper-output", "Tin Can Call aaaaaaaa"),
];
class FakeTrack extends EventTarget {
  enabled = true;
  readyState = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
}
class FakeContext extends EventTarget {
  state = "running";
  sinkId = "speakers";
  setSinkId = vi.fn(async (sink: string) => {
    this.sinkId = sink;
    this.dispatchEvent(new Event("sinkchange"));
  });
  createMediaStreamSource = () => node();
  createAnalyser = () => ({ ...node(), fftSize: 256, getFloatTimeDomainData: vi.fn() });
  createGain = () => ({ ...node(), gain: { value: 0 } });
  destination = {};
}
function node() {
  return { connect: (next: unknown) => next, disconnect: vi.fn() };
}
function stream(track: FakeTrack) {
  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

let context: FakeContext;
let track: FakeTrack;
let abort: AbortController;
let watch: ReadableStreamDefaultController<Uint8Array>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let gum: ReturnType<typeof vi.fn<typeof navigator.mediaDevices.getUserMedia>>;
let enumerate: ReturnType<typeof vi.fn<typeof navigator.mediaDevices.enumerateDevices>>;
const lost = vi.fn();
const begin = () =>
  captureHelperAudio(selection, context as unknown as AudioContext, "speakers", abort.signal, lost);
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  track = new FakeTrack();
  context = new FakeContext();
  abort = new AbortController();
  lost.mockReset();
  // Feature detection intentionally checks the prototype, like real browsers.
  Object.defineProperty(FakeContext.prototype, "setSinkId", { value: () => undefined, configurable: true });
  vi.stubGlobal("AudioContext", FakeContext);
  gum = vi.fn<typeof navigator.mediaDevices.getUserMedia>().mockResolvedValue(stream(track));
  enumerate = vi.fn<typeof navigator.mediaDevices.enumerateDevices>().mockResolvedValue(devices);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: gum, enumerateDevices: enumerate } });
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/watch")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          watch = controller;
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                sources: [{ id: "101", name: "Game", detail: "", running: true }],
                error: null,
              }) + "\n",
            ),
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              if (controller.desiredSize !== null) controller.close();
            },
            { once: true },
          );
        },
      });
      return new Response(body);
    }
    if (path.endsWith("/session"))
      return json({
        id,
        sourceLabel: "Tin Can Stream aaaaaaaa",
        outputLabel: "Tin Can Call aaaaaaaa",
      });
    return json({ started: true });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  abort.abort();
  await vi.waitFor(() => expect(useHelperAudio.getState().active).toBe(false));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("application audio ownership", () => {
  it("captures only the exact virtual input, protects call output before starting, and restores it before DELETE", async () => {
    const capture = await begin();
    expect(gum).toHaveBeenCalledExactlyOnceWith({
      audio: {
        deviceId: { exact: "helper-input" },
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    const startIndex = fetchMock.mock.calls.findIndex(([url]) => String(url).endsWith("/start"));
    expect(context.setSinkId.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[startIndex]!,
    );
    expect(useHelperAudio.getState()).toMatchObject({ active: true, names: ["Game"], missing: false });
    await capture.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(context.sinkId).toBe("speakers");
    const deleteIndex = fetchMock.mock.calls.findIndex(([, init]) => init?.method === "DELETE");
    expect(context.setSinkId.mock.invocationCallOrder[1]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[deleteIndex]!,
    );
    await capture.stop();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(lost).not.toHaveBeenCalled();
  });

  it("stops a getUserMedia result that arrives after cancellation", async () => {
    const pendingStream = deferred<MediaStream>();
    gum.mockReturnValueOnce(pendingStream.promise);
    const pending = begin();
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(gum).toHaveBeenCalled());
    abort.abort();
    pendingStream.resolve(stream(track));
    await failure;
    expect(track.stop).toHaveBeenCalled();
    expect(context.setSinkId).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/start"))).toBe(false);
  });

  it("restores output even when setSinkId finishes after cancellation", async () => {
    const pendingSink = deferred<void>();
    context.setSinkId.mockImplementationOnce(async (sink) => {
      await pendingSink.promise;
      context.sinkId = sink;
    });
    const pending = begin();
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(context.setSinkId).toHaveBeenCalled());
    abort.abort();
    pendingSink.resolve();
    await failure;
    expect(context.sinkId).toBe("speakers");
    expect(track.stop).toHaveBeenCalled();
  });

  it("deletes a session created after cancellation without opening a microphone", async () => {
    const pendingResponse = deferred<Response>();
    fetchMock.mockReturnValueOnce(pendingResponse.promise);
    const pending = begin();
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    abort.abort();
    pendingResponse.resolve(
      json({ id, sourceLabel: "Tin Can Stream aaaaaaaa", outputLabel: "Tin Can Call aaaaaaaa" }),
    );
    await failure;
    expect(gum).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("never falls back to the microphone when exact-device capture is denied", async () => {
    gum.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(begin()).rejects.toEqual(new HelperError("permission_denied"));
    expect(gum).toHaveBeenCalledTimes(1);
    expect(useHelperAudio.getState().active).toBe(false);
  });

  it("unlocks device labels before resolving the saved output", async () => {
    const unlock = new FakeTrack();
    enumerate.mockResolvedValueOnce(devices.map((d) => device(d.kind, d.deviceId, "")));
    gum.mockResolvedValueOnce(stream(unlock));
    const capture = await begin();
    expect(unlock.stop).toHaveBeenCalled();
    expect(gum).toHaveBeenNthCalledWith(1, { audio: true, video: false });
    expect(gum).toHaveBeenLastCalledWith({
      audio: {
        deviceId: { exact: "helper-input" },
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    const session = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/session"));
    expect(JSON.parse(String(session?.[1]?.body))).toMatchObject({ outputLabel: "Speakers" });
    await capture.stop();
  });

  it("maps a denied label unlock to permission_denied before creating a session", async () => {
    enumerate.mockResolvedValue(devices.map((d) => device(d.kind, d.deviceId, "")));
    gum.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(begin()).rejects.toEqual(new HelperError("permission_denied"));
    expect(gum).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cuts samples immediately if the protected output is changed", async () => {
    const capture = await begin();
    context.sinkId = "other-output";
    context.dispatchEvent(new Event("sinkchange"));
    expect(track.enabled).toBe(false);
    expect(lost).toHaveBeenCalledExactlyOnceWith("output_missing");
    await capture.stop();
    expect(context.sinkId).toBe("speakers");
  });

  it("fails closed and restores hearing when the watch connection fails", async () => {
    const capture = await begin();
    watch.error(new Error("connection lost"));
    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
    await capture.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(context.sinkId).toBe("speakers");
  });

  it("reports a closed selected stream without switching to a different application", async () => {
    const capture = await begin();
    watch.enqueue(
      new TextEncoder().encode(
        '{"sources":[{"id":"999","name":"Game","detail":"","running":true}],"error":null}\n',
      ),
    );
    await vi.waitFor(() => expect(useHelperAudio.getState().missing).toBe(true));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/start"))).toHaveLength(1);
    await capture.stop();
  });
});
