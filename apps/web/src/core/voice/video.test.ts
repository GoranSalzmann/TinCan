// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  allowedByCap,
  autoKbps,
  CAMERA_PRESETS,
  deriveLayers,
  pickCodec,
  resolveVideo,
  sanitizeCustom,
  widthOf,
  decodeWatching,
  encodeWatching,
  parseStreamKey,
  resolvePreset,
  SCREEN_PRESETS,
  streamKey,
  uploadKbps,
  viewersFrom,
} from "./video.js";
import { applyVoiceUpdate, useVoice } from "./store.js";

describe("presets within the server's cap (08 §5.2)", () => {
  it("offers only presets whose top layer fits", () => {
    expect(SCREEN_PRESETS.filter((p) => allowedByCap(p, 4000)).map((p) => p.id)).toEqual(["low", "standard"]);
    expect(CAMERA_PRESETS.filter((p) => allowedByCap(p, 1700)).map((p) => p.id)).toEqual(["low", "standard"]);
  });

  it("falls back to the best allowed preset below the wanted one, or none", () => {
    expect(resolvePreset("screen", "smooth", 4000)?.id).toBe("standard");
    expect(resolvePreset("screen", "smooth", 1200)?.id).toBe("low");
    expect(resolvePreset("screen", "smooth", 500)).toBeNull();
    expect(resolvePreset("screen", "unknown", 6000)?.id).toBe("low");
    expect(resolvePreset("camera", "standard", 1700)?.id).toBe("standard");
  });

  it("estimates upload from the layers, not from the number of viewers (G4)", () => {
    expect(uploadKbps(SCREEN_PRESETS[1]!)).toBe(4100); // 1080p30 top layer plus the 540p layer
    expect(uploadKbps(SCREEN_PRESETS[0]!)).toBe(1000); // low upload has a single layer
    expect(CAMERA_PRESETS[1]!.layers).toHaveLength(2); // 720p camera: 720, 360, 180
  });
});

describe("stream keys and the viewer list (08 §5.6)", () => {
  it("round-trips keys and rejects anything else", () => {
    expect(parseStreamKey(streamKey("u1", "screen"))).toEqual({ userId: "u1", source: "screen" });
    expect(parseStreamKey("u1:other")).toBeNull();
    expect(parseStreamKey(":screen")).toBeNull();
    expect(decodeWatching("u1:screen,bad,u2:camera")).toEqual(["u1:screen", "u2:camera"]);
    expect(decodeWatching(undefined)).toEqual([]);
    expect(encodeWatching(new Set(["u2:camera", "u1:screen"]))).toBe("u1:screen,u2:camera");
  });

  it("lists who watches what from everyone's attributes", () => {
    const v = viewersFrom([
      { identity: "ann", attributes: { watching: "me:screen" } },
      { identity: "bo", attributes: { watching: "me:screen,cy:camera" } },
      { identity: "cy", attributes: {} },
      { identity: "di", attributes: { watching: "garbage" } },
    ]);
    expect(v).toEqual({ "me:screen": ["ann", "bo"], "cy:camera": ["bo"] });
  });
});

describe("video state", () => {
  it("is part of the call: new state starts without anything watched", () => {
    const s = useVoice.getState();
    expect(s.watching).toEqual({});
    expect(s.cameraOn).toBe(false);
    expect(applyVoiceUpdate({}, { channelId: "c", userId: "u", joined: false })).toEqual({});
  });
});

describe("custom resolution, frame rate and bitrate", () => {
  const none = { vp9: false, av1Hardware: false };
  const vp9 = { vp9: true, av1Hardware: false };

  it("wants about what the presets use for the same size and rate", () => {
    expect(autoKbps(1280, 720, 30)).toBe(1650); // camera preset 1700
    expect(autoKbps(1920, 1080, 30)).toBe(3750); // screen preset 3500
    expect(autoKbps(1920, 1080, 60)).toBe(6050); // screen preset 6000
    expect(autoKbps(1280, 720, 15)).toBe(1000); // screen preset 1000
    expect(autoKbps(widthOf(2160), 2160, 60)).toBeGreaterThan(autoKbps(widthOf(2160), 2160, 30));
    expect(autoKbps(1920, 1080, 30, "vp9")).toBeLessThan(autoKbps(1920, 1080, 30));
    expect(autoKbps(320, 180, 5)).toBeGreaterThanOrEqual(100);
  });

  it("keeps VP8 up to 1080p30 and uses a better codec above it only where the browser has one", () => {
    expect(pickCodec(1080, 30, vp9)).toBe("vp8");
    expect(pickCodec(1080, 60, vp9)).toBe("vp9");
    expect(pickCodec(2160, 30, vp9)).toBe("vp9");
    expect(pickCodec(1440, 30, none)).toBe("vp8");
    expect(pickCodec(2160, 30, { vp9: true, av1Hardware: true })).toBe("av1");
    expect(pickCodec(720, 60, { vp9: true, av1Hardware: true })).toBe("av1");
  });

  it("replaces stored values that are not offered, and fills in a missing custom setting", () => {
    expect(sanitizeCustom(undefined, "screen")).toEqual({ height: 1080, fps: 30, bitrateKbps: null });
    expect(sanitizeCustom({ height: 999, fps: 7, bitrateKbps: -4 }, "camera")).toEqual({
      height: 720,
      fps: 30,
      bitrateKbps: null,
    });
    expect(sanitizeCustom({ height: 2160, fps: 60, bitrateKbps: 30_000.4 }, "screen")).toEqual({
      height: 2160,
      fps: 60,
      bitrateKbps: 30_000,
    });
  });

  it("leaves a preset as it was", () => {
    const r = resolveVideo("screen", "standard", { height: 2160, fps: 60, bitrateKbps: null }, 6000)!;
    expect(r.custom).toBe(false);
    expect(r.preset).toBe(SCREEN_PRESETS[1]);
    expect(r.codec).toBe("vp8");
    expect(
      resolveVideo("screen", "smooth", { height: 720, fps: 30, bitrateKbps: null }, 4000)!.preset.id,
    ).toBe("standard");
  });

  it("uses the automatic bitrate for a custom setting that fits the cap", () => {
    const r = resolveVideo("camera", "custom", { height: 1080, fps: 30, bitrateKbps: null }, 25_000, none)!;
    expect(r.custom).toBe(true);
    expect(r.kbps).toBe(r.wantedKbps);
    expect(r.cappedByServer).toBe(false);
    expect(r.preset).toMatchObject({ id: "custom", width: 1920, height: 1080, fps: 30 });
  });

  it("clamps to the cap, says so, and offers the highest resolution that fits", () => {
    const r = resolveVideo("screen", "custom", { height: 2160, fps: 30, bitrateKbps: null }, 6000, none)!;
    expect(r.kbps).toBe(6000);
    expect(r.wantedKbps).toBe(14_950);
    expect(r.cappedByServer).toBe(true);
    expect(r.fitHeight).toBe(1080);
    // Not capped when the cap is only a little under what is wanted.
    expect(
      resolveVideo("screen", "custom", { height: 1080, fps: 30, bitrateKbps: null }, 3500, none)!
        .cappedByServer,
    ).toBe(false);
    // A manual value above the cap is also clamped; one below it is the person's choice.
    const manual = resolveVideo(
      "screen",
      "custom",
      { height: 1080, fps: 30, bitrateKbps: 9000 },
      3000,
      none,
    )!;
    expect(manual.kbps).toBe(3000);
    const low = resolveVideo("screen", "custom", { height: 1080, fps: 30, bitrateKbps: 1000 }, 6000, none)!;
    expect(low).toMatchObject({ kbps: 1000, lowByChoice: true, cappedByServer: false });
    // Nothing fits: no suggestion.
    expect(
      resolveVideo("camera", "custom", { height: 360, fps: 60, bitrateKbps: null }, 150, none)!.fitHeight,
    ).toBeNull();
  });

  it("warns for 4K and 60 fps", () => {
    expect(
      resolveVideo("screen", "custom", { height: 2160, fps: 30, bitrateKbps: null }, 60_000, none)!.heavy,
    ).toBe(true);
    expect(
      resolveVideo("screen", "custom", { height: 1080, fps: 60, bitrateKbps: null }, 60_000, none)!.heavy,
    ).toBe(true);
    expect(
      resolveVideo("screen", "custom", { height: 1080, fps: 30, bitrateKbps: null }, 60_000, none)!.heavy,
    ).toBe(false);
  });

  it("derives lower layers, each smaller and cheaper than the one above", () => {
    const cam = resolveVideo(
      "camera",
      "custom",
      { height: 1080, fps: 60, bitrateKbps: null },
      25_000,
      none,
    )!.preset;
    expect(cam.layers.map((l) => l.height)).toEqual([270, 540]); // smallest first
    expect(cam.layers.map((l) => l.fps)).toEqual([15, 30]);
    expect(cam.layers[1]!.kbps).toBeLessThan(cam.kbps);
    expect(cam.layers[0]!.kbps).toBeLessThan(cam.layers[1]!.kbps);
    expect(deriveLayers("camera", 640, 360, 30, 600).map((l) => l.height)).toEqual([180]);
    expect(deriveLayers("screen", 1280, 720, 15, 1000)).toEqual([]);
    expect(deriveLayers("screen", 1920, 1080, 30, 3500).map((l) => l.height)).toEqual([540]);
    expect(deriveLayers("screen", 3840, 2160, 30, 15_000).map((l) => l.height)).toEqual([540, 1080]);
  });

  it("publishes a scalable codec as one encoding, so the upload is the top bitrate", () => {
    const svc = resolveVideo("screen", "custom", { height: 2160, fps: 30, bitrateKbps: null }, 60_000, vp9)!;
    expect(svc.codec).toBe("vp9");
    expect(svc.preset.svc).toBe(true);
    expect(svc.preset.layers).toEqual([]);
    expect(uploadKbps(svc.preset)).toBe(svc.kbps);
    const sim = resolveVideo("screen", "custom", { height: 1080, fps: 30, bitrateKbps: null }, 60_000, vp9)!;
    expect(uploadKbps(sim.preset)).toBeGreaterThan(sim.kbps);
  });
});
