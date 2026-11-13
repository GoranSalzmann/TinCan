// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { allowed, DEFAULT_SFX_PREFS, parsePrefs, RECIPES, type SfxName } from "./sfx.js";

describe("sfx preferences", () => {
  it("falls back to defaults for missing, broken or partial storage", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_SFX_PREFS);
    expect(parsePrefs("{nope")).toEqual(DEFAULT_SFX_PREFS);
    const p = parsePrefs(JSON.stringify({ volume: 9, categories: { voice: false } }));
    expect(p.volume).toBe(1);
    expect(p.categories).toEqual({ ...DEFAULT_SFX_PREFS.categories, voice: false });
  });

  it("honours the master switch, volume and categories", () => {
    expect(allowed("message", DEFAULT_SFX_PREFS)).toBe(true);
    expect(allowed("message", { ...DEFAULT_SFX_PREFS, enabled: false })).toBe(false);
    expect(allowed("message", { ...DEFAULT_SFX_PREFS, volume: 0 })).toBe(false);
    const noVoice = { ...DEFAULT_SFX_PREFS, categories: { ...DEFAULT_SFX_PREFS.categories, voice: false } };
    expect(allowed("peerJoin", noVoice)).toBe(false);
    expect(allowed("muteOn", noVoice)).toBe(true);
  });

  it("keeps every recipe short and audible", () => {
    for (const [name, r] of Object.entries(RECIPES) as [SfxName, (typeof RECIPES)[SfxName]][]) {
      const end = Math.max(...r.notes.map((x) => x.at + x.dur));
      expect(end, name).toBeLessThan(0.6);
      for (const x of r.notes) expect(x.gain).toBeGreaterThan(0);
    }
  });
});
