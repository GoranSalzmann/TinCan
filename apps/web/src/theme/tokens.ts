// SPDX-License-Identifier: AGPL-3.0-or-later
// Single source of the colour tokens (style guide §3). The CSS, the Tailwind theme and the contrast test derive from it;
// `tokens-doc.test.ts` fails if this file and docs/design/style-guide.md disagree.

export type ThemeName = "light" | "dark" | "hc";

/** [token, light, dark, high contrast]. Eight hex digits are translucent (#RRGGBBAA). */
export const COLOR_TOKENS: readonly (readonly [string, string, string, string])[] = [
  ["--color-bg-rail", "#E2E5EA", "#0E1014", "#000000"],
  ["--color-bg-sidebar", "#F1F3F6", "#16191E", "#000000"],
  ["--color-bg", "#FFFFFF", "#1D2026", "#000000"],
  ["--color-bg-elevated", "#FFFFFF", "#262A31", "#000000"],
  ["--color-bg-input", "#F3F4F7", "#2A2E36", "#000000"],
  ["--color-bg-hover", "#E7EAEF", "#2C3038", "#1F1F1F"],
  ["--color-bg-selected", "#DADFE6", "#353A44", "#2E2E2E"],
  ["--color-bg-mention", "#FDF3DC", "#3A3222", "#2B2300"],
  ["--color-bg-video", "#0A0B0D", "#000000", "#000000"],
  ["--color-bg-video-label", "#000000B8", "#000000B8", "#000000E0"],
  ["--color-overlay", "#0A0B0D99", "#000000B3", "#000000D9"],
  ["--color-text", "#11161C", "#ECEFF3", "#FFFFFF"],
  ["--color-text-muted", "#4B5462", "#A9B1BE", "#D9D9D9"],
  ["--color-text-disabled", "#8C95A2", "#6C7482", "#9E9E9E"],
  ["--color-text-link", "#0B6A62", "#63DCCB", "#8CD3FF"],
  ["--color-text-on-video", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
  ["--color-accent", "#0F766E", "#34C3B0", "#5CC8FF"],
  ["--color-accent-hover", "#0B5F58", "#5ED6C5", "#9ADEFF"],
  ["--color-accent-text", "#0B6A62", "#63DCCB", "#5CC8FF"],
  ["--color-text-on-accent", "#FFFFFF", "#04211D", "#000000"],
  ["--color-border", "#DADFE6", "#30353E", "#8A8A8A"],
  ["--color-border-control", "#7B8595", "#7C8595", "#FFFFFF"],
  ["--color-focus", "#1F5FD1", "#7EB0FF", "#FFD60A"],
  ["--color-danger", "#C4261C", "#D02F25", "#FF6B6B"],
  ["--color-text-on-danger", "#FFFFFF", "#FFFFFF", "#000000"],
  ["--color-danger-text", "#B42318", "#FF8F85", "#FF8F8F"],
  ["--color-danger-bg-subtle", "#FDECEA", "#3D1F1E", "#330000"],
  ["--color-warning", "#B54708", "#F6BE5C", "#FFD60A"],
  ["--color-warning-text", "#8F3A06", "#F6BE5C", "#FFD60A"],
  ["--color-warning-bg-subtle", "#FEF2DF", "#3A2D15", "#332B00"],
  ["--color-success-text", "#067647", "#52E0A0", "#5CFF9D"],
  ["--color-success-bg-subtle", "#E5F5EC", "#15301F", "#00331A"],
  ["--color-speaking", "#0C8A4C", "#3DDC84", "#5CFF9D"],
  ["--color-live", "#C4261C", "#D02F25", "#FF6B6B"],
  ["--color-text-on-live", "#FFFFFF", "#FFFFFF", "#000000"],
  ["--color-presence-online", "#12854C", "#3DDC84", "#5CFF9D"],
  ["--color-presence-idle", "#A65A06", "#F6BE5C", "#FFD60A"],
  ["--color-presence-dnd", "#C4261C", "#F2555A", "#FF6B6B"],
  ["--color-presence-offline", "#737D8C", "#808999", "#BDBDBD"],
];

export const ACCENT_NAMES = ["teal", "blue", "violet", "rose", "amber", "green", "graphite"] as const;
export type AccentName = (typeof ACCENT_NAMES)[number];

/** Per preset and theme: accent, accent-hover, accent-text, text-on-accent (style guide §3.2). */
export const ACCENT_PRESETS: Record<AccentName, { light: AccentSet; dark: AccentSet }> = {
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
  amber: {
    light: { accent: "#A34F00", hover: "#853F00", text: "#8F4500", onAccent: "#FFFFFF" },
    dark: { accent: "#F2B13D", hover: "#F6C467", text: "#F6BE5C", onAccent: "#2B1A00" },
  },
  green: {
    light: { accent: "#13773F", hover: "#0E5F32", text: "#0F6D39", onAccent: "#FFFFFF" },
    dark: { accent: "#45C97A", hover: "#6CD898", text: "#62D690", onAccent: "#052211" },
  },
  graphite: {
    light: { accent: "#39414D", hover: "#262C35", text: "#39414D", onAccent: "#FFFFFF" },
    dark: { accent: "#B8C0CC", hover: "#D0D6DE", text: "#C3CAD4", onAccent: "#11161C" },
  },
};

export interface AccentSet {
  accent: string;
  hover: string;
  text: string;
  onAccent: string;
}
