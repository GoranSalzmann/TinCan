// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";

/**
 * Interface sounds. Every sound is synthesised with WebAudio from a few short notes, so there are no asset files to
 * ship, license or cache. Sounds are grouped in categories the person can switch off one by one; the choice stays in
 * this browser (localStorage), like the device ids, because what is pleasant depends on the room and the headset.
 */
export type SfxCategory = "messages" | "voice" | "controls" | "alerts";

export type SfxName =
  | "message"
  | "mention"
  | "voiceJoin"
  | "voiceLeave"
  | "peerJoin"
  | "peerLeave"
  | "muteOn"
  | "muteOff"
  | "deafenOn"
  | "deafenOff"
  | "shareStart"
  | "shareStop"
  | "disconnected"
  | "error";

interface Note {
  /** Frequency in Hz. */
  f: number;
  /** Start offset in seconds. */
  at: number;
  /** Length in seconds, including the release. */
  dur: number;
  /** Peak gain before the master volume, 0…1. */
  gain: number;
  type?: OscillatorType;
}

interface Recipe {
  category: SfxCategory;
  notes: readonly Note[];
}

const n = (f: number, at: number, dur: number, gain = 0.5, type: OscillatorType = "sine"): Note => ({
  f,
  at,
  dur,
  gain,
  type,
});

/** Rising pairs mean "on / arrived", falling pairs mean "off / gone". Pitches sit around A5 and stay soft. */
export const RECIPES: Record<SfxName, Recipe> = {
  message: { category: "messages", notes: [n(784, 0, 0.12, 0.4), n(1047, 0.07, 0.16, 0.4)] },
  mention: {
    category: "messages",
    notes: [n(880, 0, 0.12, 0.5), n(1175, 0.08, 0.12, 0.5), n(1568, 0.16, 0.22, 0.5)],
  },
  voiceJoin: {
    category: "voice",
    notes: [n(523, 0, 0.14, 0.5), n(659, 0.1, 0.14, 0.5), n(784, 0.2, 0.24, 0.5)],
  },
  voiceLeave: {
    category: "voice",
    notes: [n(784, 0, 0.14, 0.5), n(659, 0.1, 0.14, 0.5), n(523, 0.2, 0.24, 0.5)],
  },
  peerJoin: { category: "voice", notes: [n(659, 0, 0.1, 0.35), n(880, 0.07, 0.16, 0.35)] },
  peerLeave: { category: "voice", notes: [n(659, 0, 0.1, 0.35), n(494, 0.07, 0.16, 0.35)] },
  muteOn: { category: "controls", notes: [n(740, 0, 0.07, 0.35), n(494, 0.05, 0.1, 0.35)] },
  muteOff: { category: "controls", notes: [n(494, 0, 0.07, 0.35), n(740, 0.05, 0.1, 0.35)] },
  deafenOn: {
    category: "controls",
    notes: [n(740, 0, 0.07, 0.35), n(554, 0.06, 0.07, 0.35), n(392, 0.12, 0.12, 0.35)],
  },
  deafenOff: {
    category: "controls",
    notes: [n(392, 0, 0.07, 0.35), n(554, 0.06, 0.07, 0.35), n(740, 0.12, 0.12, 0.35)],
  },
  shareStart: {
    category: "controls",
    notes: [n(587, 0, 0.09, 0.35, "triangle"), n(880, 0.07, 0.15, 0.35, "triangle")],
  },
  shareStop: {
    category: "controls",
    notes: [n(880, 0, 0.09, 0.35, "triangle"), n(587, 0.07, 0.15, 0.35, "triangle")],
  },
  disconnected: {
    category: "alerts",
    notes: [
      n(440, 0, 0.16, 0.45, "triangle"),
      n(330, 0.14, 0.16, 0.45, "triangle"),
      n(247, 0.28, 0.3, 0.45, "triangle"),
    ],
  },
  error: { category: "alerts", notes: [n(311, 0, 0.1, 0.4, "triangle"), n(233, 0.09, 0.2, 0.4, "triangle")] },
};

export interface SfxPrefs {
  enabled: boolean;
  /** Master volume 0…1. */
  volume: number;
  categories: Record<SfxCategory, boolean>;
}

export const DEFAULT_SFX_PREFS: SfxPrefs = {
  enabled: true,
  volume: 0.5,
  categories: { messages: true, voice: true, controls: true, alerts: true },
};

const KEY = "tincan.sfx.v1";

export function parsePrefs(raw: string | null): SfxPrefs {
  if (!raw) return DEFAULT_SFX_PREFS;
  try {
    const p = JSON.parse(raw) as Partial<SfxPrefs>;
    const volume =
      typeof p.volume === "number" && Number.isFinite(p.volume) ? p.volume : DEFAULT_SFX_PREFS.volume;
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULT_SFX_PREFS.enabled,
      volume: Math.min(1, Math.max(0, volume)),
      categories: { ...DEFAULT_SFX_PREFS.categories, ...(p.categories ?? {}) },
    };
  } catch {
    return DEFAULT_SFX_PREFS;
  }
}

function load(): SfxPrefs {
  try {
    return parsePrefs(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_SFX_PREFS; // blocked storage
  }
}

interface SfxState {
  prefs: SfxPrefs;
  set: (change: Partial<Omit<SfxPrefs, "categories">>) => void;
  setCategory: (category: SfxCategory, on: boolean) => void;
}

export const useSfxPrefs = create<SfxState>((set, get) => {
  const save = (prefs: SfxPrefs) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      // keep working without persistence
    }
    set({ prefs });
  };
  return {
    prefs: load(),
    set: (change) => save({ ...get().prefs, ...change }),
    setCategory: (category, on) =>
      save({ ...get().prefs, categories: { ...get().prefs.categories, [category]: on } }),
  };
});

/** Whether a sound may play with these preferences. Pure, so it is easy to test. */
export function allowed(name: SfxName, prefs: SfxPrefs): boolean {
  return prefs.enabled && prefs.volume > 0 && prefs.categories[RECIPES[name].category];
}

let ctx: AudioContext | null = null;
/** Rapid repeats of one sound (a burst of messages) collapse into one. */
const lastPlayed = new Map<SfxName, number>();
const MIN_GAP_MS = 120;

function context(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    ctx ??= new AudioContext({ latencyHint: "interactive" });
    // Browsers keep a context suspended until the person has interacted with the page; resume is a no-op afterwards.
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

/** Plays one sound if the preferences allow it. Never throws: a missing sound must not break the action behind it. */
export function playSfx(name: SfxName, opts: { force?: boolean } = {}): void {
  const prefs = useSfxPrefs.getState().prefs;
  if (!opts.force && !allowed(name, prefs)) return;
  const now = Date.now();
  if (now - (lastPlayed.get(name) ?? 0) < MIN_GAP_MS) return;
  lastPlayed.set(name, now);
  const c = context();
  if (!c) return;
  try {
    const t0 = c.currentTime + 0.01;
    // Squared volume tracks perceived loudness better than a linear slider; 0.25 keeps the peak well under speech.
    const master = c.createGain();
    master.gain.value = prefs.volume * prefs.volume * 0.25;
    master.connect(c.destination);
    for (const note of RECIPES[name].notes) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = note.type ?? "sine";
      osc.frequency.value = note.f;
      const start = t0 + note.at;
      const end = start + note.dur;
      // Short attack and exponential release avoid clicks.
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(note.gain, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(g).connect(master);
      osc.start(start);
      osc.stop(end + 0.02);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
    }
    const last = RECIPES[name].notes.reduce((m, x) => Math.max(m, x.at + x.dur), 0);
    setTimeout(() => master.disconnect(), (last + 0.1) * 1000);
  } catch {
    // ignore
  }
}
