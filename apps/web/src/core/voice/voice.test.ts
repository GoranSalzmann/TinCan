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
import { autoThreshold, dbToGain, PushToTalk, rms, VoiceActivity } from "./transmit.js";

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

  it("derives an automatic threshold above the noise floor within sane bounds", () => {
    expect(autoThreshold(0)).toBeCloseTo(0.02);
    expect(autoThreshold(0.05)).toBeGreaterThan(0.05);
    expect(autoThreshold(5)).toBe(0.5);
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
