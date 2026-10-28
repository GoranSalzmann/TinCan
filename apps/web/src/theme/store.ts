// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { ACCENT_NAMES, type AccentName } from "./tokens.js";

/** Appearance (style guide §2). `system` leaves `data-theme` unset so the media queries in the CSS decide. */
export type ThemePreference = "system" | "light" | "dark" | "hc";

const KEY = "tincan.appearance";

interface Stored {
  theme: ThemePreference;
  accent: AccentName;
}

const DEFAULTS: Stored = { theme: "system", accent: "teal" };

function read(): Stored {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Stored>;
    return {
      theme: (["system", "light", "dark", "hc"] as const).includes(v.theme as ThemePreference)
        ? (v.theme as ThemePreference)
        : DEFAULTS.theme,
      accent: ACCENT_NAMES.includes(v.accent as AccentName) ? (v.accent as AccentName) : DEFAULTS.accent,
    };
  } catch {
    return DEFAULTS; // storage can be blocked or empty (private windows)
  }
}

export function applyAppearance(s: Stored, root: HTMLElement = document.documentElement): void {
  if (s.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  // High contrast keeps its own accent (style guide §3.2); teal is the default values and needs no attribute.
  if (s.accent === "teal" || s.theme === "hc") delete root.dataset.accent;
  else root.dataset.accent = s.accent;
}

interface AppearanceState extends Stored {
  setTheme: (theme: ThemePreference) => void;
  setAccent: (accent: AccentName) => void;
}

export const useAppearance = create<AppearanceState>((set, get) => {
  const persist = () => {
    const { theme, accent } = get();
    applyAppearance({ theme, accent });
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ theme, accent }));
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
    setAccent(accent) {
      set({ accent });
      persist();
    },
  };
});

export function initAppearance(): void {
  const { theme, accent } = useAppearance.getState();
  applyAppearance({ theme, accent });
}
