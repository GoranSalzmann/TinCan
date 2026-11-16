// SPDX-License-Identifier: AGPL-3.0-or-later
// Single source of the colour tokens (style guide §3). The CSS, the Tailwind theme and the contrast test derive from it;
// `tokens-doc.test.ts` fails if this file and docs/design/style-guide.md disagree.

export type ThemeName = "light" | "dark" | "hc";

/** [token, light, dark, high contrast]. Eight hex digits are translucent (#RRGGBBAA). */
export const COLOR_TOKENS: readonly (readonly [string, string, string, string])[] = [
  ["--color-bg-rail", "#E5E0D7", "#0A0908", "#000000"],
  ["--color-bg-sidebar", "#EFEBE4", "#0F0E0C", "#000000"],
  ["--color-bg", "#F8F6F2", "#151412", "#000000"],
  ["--color-bg-elevated", "#FFFFFF", "#1C1A17", "#000000"],
  ["--color-bg-input", "#EEEAE3", "#1A1916", "#000000"],
  ["--color-bg-hover", "#E8E3DB", "#211F1C", "#1F1F1F"],
  ["--color-bg-selected", "#DFD9CF", "#2A2723", "#2E2E2E"],
  ["--color-bg-mention", "#FBE7D5", "#2C1D11", "#2B1600"],
  ["--color-bg-video", "#0A0908", "#000000", "#000000"],
  ["--color-bg-video-label", "#000000B8", "#000000B8", "#000000E0"],
  ["--color-overlay", "#0F0E0C99", "#000000B3", "#000000D9"],
  ["--color-text", "#0F0E0C", "#EDEAE5", "#FFFFFF"],
  ["--color-text-muted", "#5C5852", "#A39E96", "#D9D9D9"],
  ["--color-text-disabled", "#9C978F", "#67625B", "#9E9E9E"],
  ["--color-text-link", "#983D00", "#FF9450", "#FFB870"],
  ["--color-text-on-video", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
  ["--color-accent", "#C24E00", "#E86101", "#FF9F43"],
  ["--color-accent-hover", "#A04000", "#FF7A1F", "#FFB870"],
  ["--color-accent-text", "#983D00", "#FF9450", "#FF9F43"],
  ["--color-text-on-accent", "#FFFFFF", "#0F0E0C", "#000000"],
  ["--color-border", "#DCD6CC", "#2A2723", "#8A8A8A"],
  ["--color-border-control", "#86807A", "#6F6A63", "#FFFFFF"],
  ["--color-focus", "#1F5FD1", "#7EB0FF", "#FFD60A"],
  ["--color-danger", "#C8262E", "#D7303A", "#FF6B6B"],
  ["--color-text-on-danger", "#FFFFFF", "#FFFFFF", "#000000"],
  ["--color-danger-text", "#B0202A", "#FF8A85", "#FF8F8F"],
  ["--color-danger-bg-subtle", "#F9E3E0", "#321613", "#330000"],
  ["--color-warning", "#9A6400", "#F2C14E", "#FFD60A"],
  ["--color-warning-text", "#7A5000", "#F2C14E", "#FFD60A"],
  ["--color-warning-bg-subtle", "#F7EDD5", "#2D2410", "#332B00"],
  ["--color-success-text", "#14713D", "#5ED38A", "#5CFF9D"],
  ["--color-success-bg-subtle", "#E2F0E4", "#13261A", "#00331A"],
  ["--color-speaking", "#16853F", "#4ADE80", "#5CFF9D"],
  ["--color-live", "#C8262E", "#D7303A", "#FF6B6B"],
  ["--color-text-on-live", "#FFFFFF", "#FFFFFF", "#000000"],
  ["--color-presence-online", "#16853F", "#4ADE80", "#5CFF9D"],
  ["--color-presence-idle", "#9A6400", "#F2C14E", "#FFD60A"],
  ["--color-presence-dnd", "#C8262E", "#F2555A", "#FF6B6B"],
  ["--color-presence-offline", "#7C776F", "#857F77", "#BDBDBD"],
];

export const ACCENT_NAMES = ["ember", "teal", "blue", "violet", "rose", "green", "graphite"] as const;
export type AccentName = (typeof ACCENT_NAMES)[number];

/** Per preset and theme: accent, accent-hover, accent-text, text-on-accent (style guide §3.2). */
export const ACCENT_PRESETS: Record<AccentName, { light: AccentSet; dark: AccentSet }> = {
  ember: {
    light: { accent: "#C24E00", hover: "#A04000", text: "#983D00", onAccent: "#FFFFFF" },
    dark: { accent: "#E86101", hover: "#FF7A1F", text: "#FF9450", onAccent: "#0F0E0C" },
  },
  teal: {
    light: { accent: "#0F766E", hover: "#0B5F58", text: "#0B6A62", onAccent: "#FFFFFF" },
    dark: { accent: "#34C3B0", hover: "#5ED6C5", text: "#63DCCB", onAccent: "#04211D" },
  },
  blue: {
    light: { accent: "#2557D6", hover: "#1C45AD", text: "#1F4FC4", onAccent: "#FFFFFF" },
    dark: { accent: "#6C9BFF", hover: "#93B5FF", text: "#8DB1FF", onAccent: "#06142E" },
  },
  violet: {
    light: { accent: "#6D3FD1", hover: "#5730A8", text: "#6236C2", onAccent: "#FFFFFF" },
    dark: { accent: "#A58BFF", hover: "#BDA9FF", text: "#B9A5FF", onAccent: "#160B33" },
  },
  rose: {
    light: { accent: "#C0245C", hover: "#9C1C4A", text: "#AE1F53", onAccent: "#FFFFFF" },
    dark: { accent: "#FF7AA8", hover: "#FF9DBE", text: "#FF94B9", onAccent: "#33081A" },
  },
  green: {
    light: { accent: "#13773F", hover: "#0E5F32", text: "#0F6D39", onAccent: "#FFFFFF" },
    dark: { accent: "#45C97A", hover: "#6CD898", text: "#62D690", onAccent: "#052211" },
  },
  graphite: {
    light: { accent: "#3A3631", hover: "#26231F", text: "#3A3631", onAccent: "#FFFFFF" },
    dark: { accent: "#C9C3BA", hover: "#DDD8D0", text: "#D2CCC3", onAccent: "#0F0E0C" },
  },
};

export interface AccentSet {
  accent: string;
  hover: string;
  text: string;
  onAccent: string;
}
