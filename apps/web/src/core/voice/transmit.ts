// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When does the microphone transmit (09 §4, §10)? Pure state machines so they can be tested without a browser.
 */

export interface PttOptions {
  releaseDelayMs: number;
  onChange: (open: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/**
 * Push to talk, in-window only (13 §4.2): the key opens the mic, release closes it after a short delay so word endings
 * are not clipped. Key repeat is ignored, and losing focus counts as release so a stuck key cannot keep the mic open.
 */
export class PushToTalk {
  #open = false;
  #held = false;
  #timer: unknown = null;
  readonly #o: Required<PttOptions>;

  constructor(o: PttOptions) {
    this.#o = {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      ...o,
    };
  }

  get open(): boolean {
    return this.#open;
  }

  down(): void {
    if (this.#held) return;
    this.#held = true;
    if (this.#timer !== null) this.#o.clearTimer(this.#timer);
    this.#timer = null;
    this.#set(true);
  }

  up(): void {
    if (!this.#held) return;
    this.#held = false;
    if (this.#o.releaseDelayMs <= 0) return this.#set(false);
    this.#timer = this.#o.setTimer(() => {
      this.#timer = null;
      this.#set(false);
    }, this.#o.releaseDelayMs);
  }

  /** Window blur, tab hidden or leaving the call. */
  reset(): void {
    this.#held = false;
    if (this.#timer !== null) this.#o.clearTimer(this.#timer);
    this.#timer = null;
    this.#set(false);
  }

  #set(open: boolean): void {
    if (open === this.#open) return;
    this.#open = open;
    this.#o.onChange(open);
  }
}

/**
 * Voice-activity gate for the *local* indicator and for deciding whether "speaking" is shown before LiveKit's
 * server-side detection arrives (08 §6). Three things keep it steady:
 * - attack: it opens only once the level has stayed above the threshold for `attackMs`, so a click or a tap that slips
 *   through the denoiser does not light the ring;
 * - hysteresis: once open, it stays open while the level is above a lower close threshold (`closeRatio` × threshold), so
 *   speech hovering around the threshold does not toggle it;
 * - hang: it closes only after `hangMs` below the close threshold, so the gaps between words do not switch it off.
 */
export class VoiceActivity {
  #speaking = false;
  #lastAbove = 0;
  #runStart: number | null = null;
  #threshold: number;
  readonly #hangMs: number;
  readonly #attackMs: number;
  readonly #closeRatio: number;

  constructor(threshold: number, o: { hangMs?: number; attackMs?: number; closeRatio?: number } = {}) {
    this.#threshold = threshold;
    this.#hangMs = o.hangMs ?? 400;
    this.#attackMs = o.attackMs ?? 80;
    this.#closeRatio = o.closeRatio ?? 0.63; // about −4 dB
  }

  /** The automatic sensitivity follows the room's noise floor, so the threshold moves while the gate is in use. */
  setThreshold(threshold: number): void {
    this.#threshold = threshold;
  }

  /** Feed a level 0…1 with a timestamp; returns whether the person is speaking now. */
  update(level: number, now: number): boolean {
    if (this.#speaking) {
      if (level >= this.#threshold * this.#closeRatio) this.#lastAbove = now;
      else if (now - this.#lastAbove > this.#hangMs) {
        this.#speaking = false;
        this.#runStart = null;
      }
      return this.#speaking;
    }
    if (level < this.#threshold) {
      this.#runStart = null;
      return false;
    }
    this.#runStart ??= now;
    if (now - this.#runStart >= this.#attackMs) {
      this.#speaking = true;
      this.#lastAbove = now;
    }
    return this.#speaking;
  }
}

/**
 * Automatic sensitivity (W-21 "Set automatically"): 10 dB above the noise floor, never below −45 dBFS and never above 0.5.
 * Levels here are linear RMS, 0…1. The minimum matters most: after the denoiser and the noise gate (which opens at −50 dBFS)
 * the pauses are close to digital silence, the floor collapses, and the threshold sits at this minimum. At −50 it sat
 * exactly where the gate opens, so every breath or click the gate let through lit the ring.
 */
export function autoThreshold(noiseFloor: number): number {
  return Math.min(0.5, Math.max(0.0056, noiseFloor * 3.2));
}

/**
 * Tracks the noise floor of a level signal: it falls to a quiet moment at once (a gap between two words is enough) and
 * rises only slowly, so continuous speech does not drag the floor up to the speech level and switch itself off.
 */
export class NoiseFloor {
  #floor: number;
  readonly #rise: number;

  constructor(initial = 0.002, risePerSecond = 1.1, tickMs = 40) {
    this.#floor = initial;
    this.#rise = risePerSecond ** (tickMs / 1000);
  }

  update(level: number): number {
    this.#floor = level < this.#floor ? level : Math.min(level, this.#floor * this.#rise);
    return Math.max(this.#floor, 0.0003);
  }
}

/** RMS of a float time-domain buffer, 0…1. */
export function rms(buf: Float32Array): number {
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / (buf.length || 1));
}

/** Gain in dB → linear. */
export const dbToGain = (db: number): number => 10 ** (db / 20);
