// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";

/**
 * Audio preferences (09 §6, W-21). Device ids are per browser and stay in localStorage; the preset, noise tier and
 * transmit mode follow the person across devices through synced settings (the server registered `audio.*`).
 */
export type Preset = "standard" | "aggressive" | "natural" | "studio" | "custom";
/** 09 §3: A = DeepFilterNet-class (not shipped in M3, D2), B = RNNoise, C = browser, D = off. */
export type NoiseTier = "rnnoise" | "browser" | "off";
export type TransmitMode = "vad" | "ptt";

export interface AudioPrefs {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  preset: Preset;
  noiseTier: NoiseTier;
  /** Gate in front of the encoder: only used by the Aggressive preset and Custom. */
  noiseGate: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  /** Linear gain in dB applied after the denoiser, −12…+12. */
  inputGainDb: number;
  transmitMode: TransmitMode;
  /** `KeyboardEvent.code`, e.g. `KeyF`. */
  pttKey: string;
  pttReleaseDelayMs: number;
  pttCues: boolean;
  /** Voice-activity threshold as a level 0…1; `null` = automatic. */
  vadThreshold: number | null;
}

export interface PresetSettings {
  noiseTier: NoiseTier;
  noiseGate: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  /** Opus: DTX on for speech, off for music; bitrate in kbit/s before the channel's cap (09 §6). */
  dtx: boolean;
  bitrateKbps: number;
  stereo: boolean;
}

export const PRESETS: Record<Exclude<Preset, "custom">, PresetSettings> = {
  standard: {
    noiseTier: "rnnoise",
    noiseGate: false,
    echoCancellation: true,
    autoGain: true,
    dtx: true,
    bitrateKbps: 32,
    stereo: false,
  },
  aggressive: {
    noiseTier: "rnnoise",
    noiseGate: true,
    echoCancellation: true,
    autoGain: false,
    dtx: true,
    bitrateKbps: 28,
    stereo: false,
  },
  natural: {
    noiseTier: "browser",
    noiseGate: false,
    echoCancellation: true,
    autoGain: false,
    dtx: true,
    bitrateKbps: 40,
    stereo: false,
  },
  studio: {
    noiseTier: "off",
    noiseGate: false,
    echoCancellation: false,
    autoGain: false,
    dtx: false,
    bitrateKbps: 64,
    stereo: false,
  },
};

/** What the capture and encoder should do for the current preferences. */
export function effectiveSettings(p: AudioPrefs): PresetSettings {
  if (p.preset !== "custom") return PRESETS[p.preset];
  return {
    noiseTier: p.noiseTier,
    noiseGate: p.noiseGate,
    echoCancellation: p.echoCancellation,
    autoGain: p.autoGain,
    dtx: p.noiseTier !== "off" || p.echoCancellation,
    bitrateKbps: 40,
    stereo: false,
  };
}

/** `getUserMedia` audio constraints. Our own chain replaces the browser's noise suppression when the tier is RNNoise (09 §2). */
export function captureConstraints(p: AudioPrefs): MediaTrackConstraints {
  const s = effectiveSettings(p);
  return {
    ...(p.inputDeviceId ? { deviceId: { exact: p.inputDeviceId } } : {}),
    channelCount: 1,
    sampleRate: 48000,
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseTier === "browser",
    autoGainControl: s.autoGain,
  };
}

/** Changing an advanced control switches the profile to Custom (W-21). */
export function withAdvancedChange(p: AudioPrefs, change: Partial<AudioPrefs>): AudioPrefs {
  const base = p.preset === "custom" ? p : { ...p, ...PRESETS[p.preset], preset: "custom" as const };
  return { ...base, ...change, preset: "custom" };
}

export const DEFAULT_PREFS: AudioPrefs = {
  inputDeviceId: null,
  outputDeviceId: null,
  preset: "standard",
  noiseTier: "rnnoise",
  noiseGate: false,
  echoCancellation: true,
  autoGain: true,
  inputGainDb: 0,
  transmitMode: "vad",
  pttKey: "KeyF",
  pttReleaseDelayMs: 200,
  pttCues: true,
  vadThreshold: null,
};

const KEY = "tincan.audio.v1";

function load(): AudioPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<AudioPrefs>) };
  } catch {
    // private window or blocked storage: defaults
  }
  return DEFAULT_PREFS;
}

interface PrefsState {
  prefs: AudioPrefs;
  set: (change: Partial<AudioPrefs>) => void;
  /** Preset buttons: copies the preset's toggles so Custom starts from what the person last had. */
  setPreset: (preset: Preset) => void;
  setAdvanced: (change: Partial<AudioPrefs>) => void;
}

export const useAudioPrefs = create<PrefsState>((set, get) => {
  const save = (prefs: AudioPrefs) => {
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
    setPreset: (preset) => {
      const cur = get().prefs;
      if (preset === "custom") return save({ ...cur, preset });
      const s = PRESETS[preset];
      save({
        ...cur,
        preset,
        noiseTier: s.noiseTier,
        noiseGate: s.noiseGate,
        echoCancellation: s.echoCancellation,
        autoGain: s.autoGain,
      });
    },
    setAdvanced: (change) => save(withAdvancedChange(get().prefs, change)),
  };
});
