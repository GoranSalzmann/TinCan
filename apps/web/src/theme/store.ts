// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { SKIN_NAMES, type SkinName } from "./tokens.js";

/** Appearance (style guide §2). `system` leaves `data-theme` unset so the media queries in the CSS decide. */
export type ThemePreference = "system" | "light" | "dark" | "hc";

const KEY = "tincan.appearance";

interface Stored {
  theme: ThemePreference;
  skin: SkinName;
}

const DEFAULTS: Stored = { theme: "system", skin: "ember" };

function read(): Stored {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Stored>;
    return {
      theme: (["system", "light", "dark", "hc"] as const).includes(v.theme as ThemePreference)
        ? (v.theme as ThemePreference)
        : DEFAULTS.theme,
      // A stored accent from before themes existed is dropped: the default theme is the old default accent.
      skin: SKIN_NAMES.includes(v.skin as SkinName) ? (v.skin as SkinName) : DEFAULTS.skin,
    };
  } catch {
    return DEFAULTS; // storage can be blocked or empty (private windows)
  }
}

const matches = (q: string) => typeof window.matchMedia === "function" && window.matchMedia(q).matches;

/** High contrast and Windows contrast themes keep their own colours (style guide §2), so no theme applies there. */
function contrastWins(theme: ThemePreference): boolean {
  return (
    theme === "hc" ||
    matches("(forced-colors: active)") ||
    (theme === "system" && matches("(prefers-contrast: more)"))
  );
}

export function applyAppearance(s: Stored, root: HTMLElement = document.documentElement): void {
  if (s.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  // Ember is the default values and needs no attribute.
  if (s.skin === "ember" || contrastWins(s.theme)) delete root.dataset.skin;
  else root.dataset.skin = s.skin;
}

interface AppearanceState extends Stored {
  setTheme: (theme: ThemePreference) => void;
  setSkin: (skin: SkinName) => void;
}

export const useAppearance = create<AppearanceState>((set, get) => {
  const persist = () => {
    const { theme, skin } = get();
    applyAppearance({ theme, skin });
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ theme, skin }));
    } catch {
      // device-local convenience only; ignore
    }
  };
  return {
    ...read(),
    setTheme(theme) {
      set({ theme });
      persist();
    },
    setSkin(skin) {
      set({ skin });
      persist();
    },
  };
});

export function initAppearance(): void {
  const apply = () => {
    const { theme, skin } = useAppearance.getState();
    applyAppearance({ theme, skin });
  };
  apply();
  // The OS can switch contrast settings while the app is open.
  if (typeof window.matchMedia === "function") {
    for (const q of ["(prefers-contrast: more)", "(forced-colors: active)"]) {
      window.matchMedia(q).addEventListener?.("change", apply);
    }
  }
}
