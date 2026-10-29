// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VoiceParticipant } from "@tincan/shared";
import { describe, expect, it } from "vitest";
import { summarise, emptyReport } from "./diagnostics.js";
import {
  captureConstraints,
  DEFAULT_PREFS,
  effectiveSettings,
  PRESETS,
  withAdvancedChange,
  type AudioPrefs,
} from "./prefs.js";
import { applyVoiceUpdate } from "./store.js";
import { autoThreshold, dbToGain, NoiseFloor, PushToTalk, rms, VoiceActivity } from "./transmit.js";

const person = (userId: string): VoiceParticipant => ({
  userId,
  joinedAt: "2026-01-01T00:00:00Z",
  sources: [],
  muted: false,
  deafened: false,
});

describe("presets (09 §6)", () => {
  it("Standard keeps echo cancellation, the RNNoise tier and AGC on", () => {
    expect(effectiveSettings(DEFAULT_PREFS)).toMatchObject({
      noiseTier: "rnnoise",
      echoCancellation: true,
      autoGain: true,
      dtx: true,
    });
  });

  it("Studio turns everything off and DTX off for music", () => {
    const s = effectiveSettings({ ...DEFAULT_PREFS, preset: "studio" });
    expect(s).toMatchObject({ noiseTier: "off", echoCancellation: false, autoGain: false, dtx: false });
    expect(s.bitrateKbps).toBeGreaterThanOrEqual(64);
  });

  it("asks the browser for its own noise suppression only in the browser tier", () => {
    const c = (p: AudioPrefs) => captureConstraints(p);
    expect(c(DEFAULT_PREFS).noiseSuppression).toBe(false); // RNNoise runs in our chain instead
    expect(c({ ...DEFAULT_PREFS, preset: "natural" }).noiseSuppression).toBe(true);
    expect(c({ ...DEFAULT_PREFS, preset: "studio" })).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(c({ ...DEFAULT_PREFS, inputDeviceId: "abc" }).deviceId).toEqual({ exact: "abc" });
    expect(c(DEFAULT_PREFS).deviceId).toBeUndefined();
  });

  it("changing an advanced control switches to Custom and keeps the rest of the preset", () => {
    const p = withAdvancedChange({ ...DEFAULT_PREFS, preset: "aggressive" }, { echoCancellation: false });
    expect(p.preset).toBe("custom");
    expect(p.noiseGate).toBe(PRESETS.aggressive.noiseGate);
    expect(p.noiseTier).toBe(PRESETS.aggressive.noiseTier);
    expect(p.echoCancellation).toBe(false);
  });
});

describe("push to talk (in window)", () => {
  function rig(releaseDelayMs = 200) {
    const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
    const events: boolean[] = [];
    const ptt = new PushToTalk({
      releaseDelayMs,
      onChange: (o) => events.push(o),
      setTimer: (fn, ms) => {
        const t = { fn, ms, id: timers.length, live: true };
        timers.push(t);
        return t.id;
      },
      clearTimer: (id) => {
        timers[id as number]!.live = false;
      },
    });
    const fire = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()));
    return { ptt, events, fire };
  }

  it("opens on key down and closes after the release delay", () => {
    const { ptt, events, fire } = rig();
    ptt.down();
    expect(ptt.open).toBe(true);
    ptt.up();
    expect(ptt.open).toBe(true); // still open during the delay: word endings are not clipped
    fire();
    expect(ptt.open).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it("ignores key repeat and cancels the pending close when pressed again", () => {
    const { ptt, events, fire } = rig();
    ptt.down();
    ptt.down();
    ptt.up();
    ptt.down();
    fire();
    expect(ptt.open).toBe(true);
    expect(events).toEqual([true]);
  });

  it("closes at once without a delay, and on losing focus", () => {
    const a = rig(0);
    a.ptt.down();
    a.ptt.up();
    expect(a.ptt.open).toBe(false);
    const b = rig();
    b.ptt.down();
    b.ptt.reset();
    expect(b.ptt.open).toBe(false);
    b.fire();
    expect(b.events).toEqual([true, false]);
  });
});

describe("voice activity", () => {
  it("holds the speaking state for a moment so it does not flicker", () => {
    const v = new VoiceActivity(0.1, 250);
    expect(v.update(0.05, 0)).toBe(false);
    expect(v.update(0.4, 100)).toBe(true);
    expect(v.update(0.01, 200)).toBe(true);
    expect(v.update(0.01, 400)).toBe(false);
  });

  it("derives an automatic threshold above the noise floor, never below -50 dBFS", () => {
    expect(autoThreshold(0)).toBeCloseTo(0.003);
    expect(autoThreshold(0.01)).toBeCloseTo(0.032);
    expect(autoThreshold(5)).toBe(0.5);
  });

  it("follows quiet speech at -30 dBFS with word gaps, as one stretch of speaking", () => {
    // Regression: a fixed threshold of about -35 dBFS switched the local ring on only for split seconds.
    const noise = new NoiseFloor();
    const vad = new VoiceActivity(autoThreshold(0.002));
    const speechRms = 0.03; // -30 dBFS
    const states: boolean[] = [];
    for (let tick = 0; tick < 300; tick++) {
      const now = tick * 40;
      const inWordGap = tick % 8 === 7; // an 80 ms gap after each 0.25 s syllable
      const level = inWordGap ? 0.0008 : speechRms;
      vad.setThreshold(autoThreshold(noise.update(level)));
      states.push(vad.update(level, now));
    }
    expect(states.slice(5).every(Boolean)).toBe(true); // on through all the gaps
    for (let tick = 300; tick < 330; tick++) {
      vad.setThreshold(autoThreshold(noise.update(0.0008)));
      states.push(vad.update(0.0008, tick * 40));
    }
    expect(states.at(-1)).toBe(false); // and off after the hold time
  });

  it("does not let 10 s of unbroken speech drag the noise floor up to the speech level", () => {
    const noise = new NoiseFloor();
    for (let i = 0; i < 25 * 10; i++) noise.update(0.03); // 10 s without a single pause
    expect(autoThreshold(noise.update(0.03))).toBeLessThan(0.05);
  });

  it("measures level and converts gain", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.995, 2);
  });
});

describe("voice presence in the client", () => {
  it("adds, updates and removes people, and keeps a person in one room only", () => {
    let p: Record<string, VoiceParticipant[]> = {};
    p = applyVoiceUpdate(p, { channelId: "a", userId: "u1", joined: true, participant: person("u1") });
    p = applyVoiceUpdate(p, { channelId: "a", userId: "u2", joined: true, participant: person("u2") });
    expect(p.a!.map((x) => x.userId)).toEqual(["u1", "u2"]);
    p = applyVoiceUpdate(p, { channelId: "b", userId: "u1", joined: true, participant: person("u1") });
    expect(p.a!.map((x) => x.userId)).toEqual(["u2"]);
    expect(p.b!.map((x) => x.userId)).toEqual(["u1"]);
    p = applyVoiceUpdate(p, { channelId: "a", userId: "u2", joined: false });
    expect(p.a).toBeUndefined();
  });

  it("is idempotent for repeated events (07 §5)", () => {
    const ev = { channelId: "a", userId: "u1", joined: true, participant: { ...person("u1"), muted: true } };
    const once = applyVoiceUpdate({}, ev);
    expect(applyVoiceUpdate(once, ev)).toEqual(once);
  });
});

describe("connection test summary (W-25)", () => {
  it("names the path the media ended up on, or none", () => {
    const r = emptyReport();
    expect(summarise(r.steps, "tcp")).toBe("tcp");
    expect(summarise(r.steps, null)).toBe("none");
    expect(summarise({ ...r.steps, relay: { state: "ok" } }, null)).toBe("relay");
  });
});

describe("per-person volume (up to 300 %)", () => {
  it("keeps old values valid and clamps or repairs the rest", async () => {
    const { clampVolume, MAX_VOLUME } = await import("./volume.js");
    expect(clampVolume(0.4)).toBe(0.4);
    expect(clampVolume(1)).toBe(1);
    expect(clampVolume(2.5)).toBe(2.5);
    expect(clampVolume(99)).toBe(MAX_VOLUME);
    expect(clampVolume(-1)).toBe(0);
    for (const bad of ["loud", null, undefined, Number.NaN, Infinity]) expect(clampVolume(bad)).toBe(1);
  });

  it("loads what was saved, including values above 1, and survives broken storage", async () => {
    const { loadVolumes, saveVolumes } = await import("./volume.js");
    let stored = "";
    const storage = { getItem: () => stored || null, setItem: (_k: string, v: string) => void (stored = v) };
    saveVolumes({ a: 2.25, b: 0.5 }, storage);
    expect(loadVolumes(storage)).toEqual({ a: 2.25, b: 0.5 });
    stored = JSON.stringify({ old: 0.8, junk: "x", huge: 50 });
    expect(loadVolumes(storage)).toEqual({ old: 0.8, junk: 1, huge: 3 });
    stored = "{not json";
    expect(loadVolumes(storage)).toEqual({});
    expect(
      loadVolumes({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toEqual({});
  });

  it("limits peaks only when boosted, so 100 % and below is untouched", async () => {
    const { limiterFor, isBoosted, percent } = await import("./volume.js");
    expect(limiterFor(1).ratio).toBe(1);
    expect(limiterFor(0.3).ratio).toBe(1);
    expect(limiterFor(1.5).ratio).toBeGreaterThan(10);
    expect(limiterFor(1.5).threshold).toBeLessThan(0);
    expect(isBoosted(1)).toBe(false);
    expect(isBoosted(1.05)).toBe(true);
    expect(percent(2.255)).toBe(226);
  });
});
