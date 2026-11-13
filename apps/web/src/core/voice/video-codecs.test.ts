// SPDX-License-Identifier: AGPL-3.0-or-later
import { supportsAV1, supportsVP9 } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("livekit-client", () => ({ supportsAV1: vi.fn(), supportsVP9: vi.fn() }));

const encodingInfo = vi.fn();
const capabilities = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(supportsVP9).mockReturnValue(false);
  vi.mocked(supportsAV1).mockReturnValue(false);
  capabilities.mockReturnValue({
    codecs: ["video/VP8", "video/H264", "video/VP9", "video/AV1"].map((mimeType) => ({ mimeType })),
  });
  vi.stubGlobal("RTCRtpSender", { getCapabilities: capabilities });
  vi.stubGlobal("navigator", { mediaCapabilities: { encodingInfo } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.resetModules();
});

describe("video encoder capability detection", () => {
  it("recognizes H.264 but follows the SDK's restrictions on advertised VP9 and AV1", async () => {
    const { detectCodecSupport } = await import("./video.js");
    expect(await detectCodecSupport()).toEqual({ h264: true, vp9: false, av1Hardware: false });
    expect(encodingInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.objectContaining({ contentType: "video/AV1" }) }),
    );
  });

  it("drops H.264 when advertised but the browser reports it cannot be encoded", async () => {
    encodingInfo.mockResolvedValue({ supported: false, powerEfficient: false, smooth: false });
    const { detectCodecSupport } = await import("./video.js");
    expect((await detectCodecSupport()).h264).toBe(false);
  });

  it("offers AV1 only when encoding is supported and power efficient", async () => {
    vi.mocked(supportsVP9).mockReturnValue(true);
    vi.mocked(supportsAV1).mockReturnValue(true);
    encodingInfo.mockResolvedValue({ supported: true, powerEfficient: true, smooth: true });
    const { detectCodecSupport, knownCodecSupport } = await import("./video.js");
    expect(await detectCodecSupport()).toEqual({ h264: true, vp9: true, av1Hardware: true });
    expect(encodingInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "webrtc",
        video: expect.objectContaining({ contentType: "video/AV1" }),
      }),
    );
    expect(knownCodecSupport().av1Hardware).toBe(true);
  });

  it.each([
    { supported: true, powerEfficient: false },
    { supported: false, powerEfficient: true },
  ])("does not offer software or unsupported AV1: %j", async (info) => {
    vi.mocked(supportsAV1).mockReturnValue(true);
    encodingInfo.mockResolvedValue(info);
    const { detectCodecSupport } = await import("./video.js");
    expect((await detectCodecSupport()).av1Hardware).toBe(false);
  });

  it("keeps other supported codecs when the AV1 probe fails", async () => {
    vi.mocked(supportsVP9).mockReturnValue(true);
    vi.mocked(supportsAV1).mockReturnValue(true);
    encodingInfo.mockRejectedValue(new Error("Unsupported probe"));
    const { detectCodecSupport } = await import("./video.js");
    expect(await detectCodecSupport()).toEqual({ h264: true, vp9: true, av1Hardware: false });
  });

  it("falls back safely when the browser has no capability API", async () => {
    vi.stubGlobal("RTCRtpSender", undefined);
    const { detectCodecSupport } = await import("./video.js");
    expect(await detectCodecSupport()).toEqual({ h264: false, vp9: false, av1Hardware: false });
  });

  it("caches the probe without changing a saved preference", async () => {
    const { detectCodecSupport, useVideoPrefs } = await import("./video.js");
    useVideoPrefs.getState().set({ screenCodec: "av1" });
    const first = detectCodecSupport();
    expect(detectCodecSupport()).toBe(first);
    await first;
    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(useVideoPrefs.getState().prefs.screenCodec).toBe("av1");
  });
});
