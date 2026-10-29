// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  allowedByCap,
  CAMERA_PRESETS,
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
