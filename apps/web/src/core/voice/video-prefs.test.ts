// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseVideoPrefs, sanitizeCodecPreference, useVideoPrefs } from "./video.js";

const KEY = "tincan.video.prefs.v1";
const defaults = parseVideoPrefs(null);

beforeEach(() => {
  localStorage.clear();
  useVideoPrefs.setState({ prefs: defaults });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useVideoPrefs.setState({ prefs: defaults });
  vi.resetModules();
});

describe("stored video codec preferences", () => {
  it("defaults missing or damaged preferences to automatic selection", () => {
    for (const value of [null, "{broken", "null", "[]", "42", "false", '"vp9"'])
      expect(parseVideoPrefs(value)).toMatchObject({ cameraCodec: "auto", screenCodec: "auto" });
  });

  it("validates codec names rather than trusting stored JSON", () => {
    for (const value of [undefined, null, "", "h265", "VP9", 42, false, {}, []]) {
      expect(sanitizeCodecPreference(value)).toBe("auto");
      expect(parseVideoPrefs(JSON.stringify({ cameraCodec: value, screenCodec: value }))).toMatchObject({
        cameraCodec: "auto",
        screenCodec: "auto",
      });
    }
  });

  it.each(["auto", "vp8", "h264", "vp9", "av1"] as const)("restores the saved %s preference", (codec) => {
    expect(parseVideoPrefs(JSON.stringify({ cameraCodec: codec, screenCodec: codec }))).toMatchObject({
      cameraCodec: codec,
      screenCodec: codec,
    });
  });

  it("extends old preferences without losing quality, devices or custom settings", () => {
    expect(
      parseVideoPrefs(
        JSON.stringify({
          cameraDeviceId: "camera-2",
          cameraPreset: "custom",
          cameraCustom: { height: 1440, fps: 60, bitrateKbps: 8000 },
          screenPreset: "low",
          shareAudio: false,
        }),
      ),
    ).toMatchObject({
      cameraDeviceId: "camera-2",
      cameraPreset: "custom",
      cameraCustom: { height: 1440, fps: 60, bitrateKbps: 8000 },
      screenPreset: "low",
      screenCustom: { height: 1080, fps: 30, bitrateKbps: null },
      shareAudio: false,
      cameraCodec: "auto",
      screenCodec: "auto",
    });
  });

  it("persists camera and screen choices independently and loads them in a fresh store", async () => {
    useVideoPrefs.getState().set({
      cameraCodec: "vp9",
      screenCodec: "h264",
      cameraPreset: "custom",
      cameraCustom: { height: 1440, fps: 60, bitrateKbps: 8000 },
    });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({
      cameraCodec: "vp9",
      screenCodec: "h264",
    });

    vi.resetModules();
    const fresh = await import("./video.js");
    expect(fresh.useVideoPrefs).not.toBe(useVideoPrefs);
    expect(fresh.useVideoPrefs.getState().prefs).toMatchObject({
      cameraCodec: "vp9",
      screenCodec: "h264",
      cameraPreset: "custom",
      cameraCustom: { height: 1440, fps: 60, bitrateKbps: 8000 },
    });
  });

  it("loads old preferences during initialization, after sanitizer constants are available", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ screenPreset: "custom", screenCustom: { height: 2160, fps: 15, bitrateKbps: 9000 } }),
    );
    vi.resetModules();
    const fresh = await import("./video.js");
    expect(fresh.useVideoPrefs.getState().prefs).toMatchObject({
      screenPreset: "custom",
      screenCustom: { height: 2160, fps: 15, bitrateKbps: 9000 },
      screenCodec: "auto",
    });
  });

  it("still changes the in-memory preference when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    expect(() => useVideoPrefs.getState().set({ screenCodec: "av1" })).not.toThrow();
    expect(useVideoPrefs.getState().prefs.screenCodec).toBe("av1");
  });

  it("initializes with defaults when storage cannot be read", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    vi.resetModules();
    const fresh = await import("./video.js");
    expect(fresh.useVideoPrefs.getState().prefs).toEqual(defaults);
  });
});
