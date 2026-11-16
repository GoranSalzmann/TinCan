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

/** Shadow of the floating surfaces (`elev-2`, style guide §8): [light, dark, high contrast]. */
export const SHADOW_ELEV: readonly [string, string, string] = [
  "0 12px 32px -12px #0F0E0C33, 0 1px 2px #0F0E0C14",
  "0 16px 40px -12px #000000B3",
  "none",
];

// ---- Themes (style guide §3.2) -------------------------------------------------------------------------------
//
// A theme ("skin" in code, so it never collides with the light/dark/high-contrast mode, which the code calls theme)
// is a whole look: surfaces, text and accent colours for light and dark, plus the type faces, corner radii, shadows
// and heading tracking. Status colours (danger, warning, success, presence, video) come from the mode and are only
// overridden where a skin's surfaces need it for contrast. High contrast ignores the skin entirely.

// Bundled faces first (src/fonts.css, served from our own origin: the CSP allows `font-src 'self'` only), then the
// system stack, which still covers scripts the bundled faces do not (CJK, Arabic, Hebrew, Thai) and emoji. Themes
// that use other faces name local system fonts only, for the same reason.
/** The default faces (style guide §5.1). */
export const FONTS = {
  display: `"Space Grotesk Variable", "Space Grotesk", system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`,
  sans: `"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`,
  mono: `"IBM Plex Mono", ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", Consolas, "Liberation Mono", "DejaVu Sans Mono", Menlo, monospace`,
} as const;

const MONO = FONTS.mono;
const SERIF_TEXT = `Charter, "Bitstream Charter", "Iowan Old Style", "Sitka Text", Cambria, Georgia, "Noto Serif", "DejaVu Serif", serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
const SERIF_DISPLAY = `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", P052, Georgia, "Noto Serif", serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
const ROUNDED = `ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", Quicksand, "Inter Variable", Inter, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;

/** The colour tokens a skin sets for each mode; anything else comes from the mode's own column above. */
export type SkinColors = {
  "--color-bg-rail": string;
  "--color-bg-sidebar": string;
  "--color-bg": string;
  "--color-bg-elevated": string;
  "--color-bg-input": string;
  "--color-bg-hover": string;
  "--color-bg-selected": string;
  "--color-bg-mention": string;
  "--color-text": string;
  "--color-text-muted": string;
  "--color-text-disabled": string;
  "--color-text-link": string;
  "--color-accent": string;
  "--color-accent-hover": string;
  "--color-accent-text": string;
  "--color-text-on-accent": string;
  "--color-border": string;
  "--color-border-control": string;
  "--color-focus": string;
} & Record<string, string>;

export interface Skin {
  light: SkinColors;
  dark: SkinColors;
  /** `--shadow-elev` per mode. */
  shadow: { light: string; dark: string };
  /** Per-mode effect variables (`--fx-*`) that skins.css uses: glows, textures, backdrops. */
  fx?: { light: Record<string, string>; dark: Record<string, string> };
  /** Mode-independent tokens: faces, radii, heading tracking. */
  props: Record<string, string>;
}

const SQUARE = { "--radius-sm": "0px", "--radius-md": "0px", "--radius-lg": "0px", "--radius-xl": "0px" };

export const SKIN_NAMES = [
  "ember",
  "phosphor",
  "broadsheet",
  "marshmallow",
  "synthwave",
  "fjord",
  "brutalist",
] as const;
export type SkinName = (typeof SKIN_NAMES)[number];

const column = (i: 1 | 2) =>
  Object.fromEntries(COLOR_TOKENS.map((r) => [r[0], r[i]])) as unknown as SkinColors;

export const SKINS: Record<SkinName, Skin> = {
  // The house look: warm graphite, near-square corners, Space Grotesk headings. The values are the token table.
  ember: {
    light: column(1),
    dark: column(2),
    shadow: { light: SHADOW_ELEV[0], dark: SHADOW_ELEV[1] },
    props: {},
  },

  // A green-screen terminal: everything in the mono face, square corners, phosphor glow and scanlines. Light is the
  // green-bar printout.
  phosphor: {
    light: {
      "--color-bg-rail": "#D9E6D2",
      "--color-bg-sidebar": "#E4EFDD",
      "--color-bg": "#F2F8EC",
      "--color-bg-elevated": "#FBFDF8",
      "--color-bg-input": "#E7F0E0",
      "--color-bg-hover": "#E0EBD8",
      "--color-bg-selected": "#D1E3C8",
      "--color-bg-mention": "#F1EBC6",
      "--color-text": "#0B220F",
      "--color-text-muted": "#3C5A41",
      "--color-text-disabled": "#89A08C",
      "--color-text-link": "#0A6A2C",
      "--color-accent": "#107A36",
      "--color-accent-hover": "#0B5F29",
      "--color-accent-text": "#0A6A2C",
      "--color-text-on-accent": "#FFFFFF",
      "--color-border": "#C3D6BA",
      "--color-border-control": "#6A876F",
      "--color-focus": "#1F5FD1",
    },
    dark: {
      "--color-bg-rail": "#040704",
      "--color-bg-sidebar": "#070B07",
      "--color-bg": "#0A0F0A",
      "--color-bg-elevated": "#0F170F",
      "--color-bg-input": "#0C130C",
      "--color-bg-hover": "#132013",
      "--color-bg-selected": "#1A2D1A",
      "--color-bg-mention": "#1F2A0C",
      "--color-text": "#C8F7C8",
      "--color-text-muted": "#80B98B",
      "--color-text-disabled": "#4B6B50",
      "--color-text-link": "#7DFFB0",
      "--color-accent": "#39FF7A",
      "--color-accent-hover": "#80FFA8",
      "--color-accent-text": "#5CFF8F",
      "--color-text-on-accent": "#021A08",
      "--color-border": "#1D3521",
      "--color-border-control": "#3F7A4C",
      "--color-focus": "#E8FF5A",
    },
    shadow: {
      light: "0 10px 28px -14px #0B220F59",
      dark: "0 0 0 1px #39FF7A2E, 0 0 28px -6px #39FF7A4D",
    },
    fx: {
      light: {
        "--fx-text-glow": "none",
        "--fx-heading-glow": "none",
        "--fx-button-glow": "none",
        "--fx-scanline": "#0B220F0F",
        "--fx-vignette": "#0B220F1A",
        "--fx-bar": "#E5F0DC",
      },
      dark: {
        "--fx-text-glow": "0 0 3px #39FF7A4D",
        "--fx-heading-glow": "0 0 10px #39FF7A8C",
        "--fx-button-glow": "0 0 16px -2px #39FF7A99",
        "--fx-scanline": "#00000066",
        "--fx-vignette": "#000000C0",
        "--fx-bar": "#0D150D",
      },
    },
    props: {
      "--font-sans": MONO,
      "--font-display": MONO,
      "--tracking-display": "0em",
      ...SQUARE,
    },
  },

  // A newspaper: serif text and headings, ink on newsprint, square corners, rules instead of shadows, one red.
  broadsheet: {
    light: {
      "--color-bg-rail": "#E3DCCF",
      "--color-bg-sidebar": "#ECE6DA",
      "--color-bg": "#F6F1E7",
      "--color-bg-elevated": "#FFFCF5",
      "--color-bg-input": "#ECE6D9",
      "--color-bg-hover": "#E8E1D3",
      "--color-bg-selected": "#DDD4C2",
      "--color-bg-mention": "#F5E0CC",
      "--color-text": "#151310",
      "--color-text-muted": "#55504A",
      "--color-text-disabled": "#A19A8D",
      "--color-text-link": "#9A1A13",
      "--color-accent": "#A3201A",
      "--color-accent-hover": "#82160F",
      "--color-accent-text": "#9A1A13",
      "--color-text-on-accent": "#FFFFFF",
      "--color-border": "#CDC3B1",
      "--color-border-control": "#7A7265",
      "--color-focus": "#1F5FD1",
    },
    dark: {
      "--color-bg-rail": "#0E0E0D",
      "--color-bg-sidebar": "#141413",
      "--color-bg": "#1A1A18",
      "--color-bg-elevated": "#222220",
      "--color-bg-input": "#1F1F1D",
      "--color-bg-hover": "#272725",
      "--color-bg-selected": "#32312E",
      "--color-bg-mention": "#361C16",
      "--color-text": "#EDE8DD",
      "--color-text-muted": "#ACA698",
      "--color-text-disabled": "#6B675F",
      "--color-text-link": "#FF8E7F",
      "--color-accent": "#EE5446",
      "--color-accent-hover": "#F7776B",
      "--color-accent-text": "#FF8E7F",
      "--color-text-on-accent": "#140B09",
      "--color-border": "#3A3934",
      "--color-border-control": "#7A766C",
      "--color-focus": "#7EB0FF",
    },
    shadow: { light: "3px 3px 0 #1513101F", dark: "3px 3px 0 #00000080" },
    fx: {
      light: {
        "--fx-paper":
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.09 0 0 0 0 0.07 0 0 0 0 0.05 0 0 0 .10 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
      },
      dark: {
        "--fx-paper":
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .05 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
      },
    },
    props: {
      "--font-sans": SERIF_TEXT,
      "--font-display": SERIF_DISPLAY,
      "--tracking-display": "-0.01em",
      ...SQUARE,
    },
  },

  // Soft and round: pastel pink and plum, generous radii, pill buttons, a rounded face where the system has one.
  marshmallow: {
    light: {
      "--color-bg-rail": "#F2E4EF",
      "--color-bg-sidebar": "#F9EDF6",
      "--color-bg": "#FFF8FC",
      "--color-bg-elevated": "#FFFFFF",
      "--color-bg-input": "#F6E9F3",
      "--color-bg-hover": "#F4E3F0",
      "--color-bg-selected": "#EBD6E7",
      "--color-bg-mention": "#FFE2EE",
      "--color-text": "#2A1B2E",
      "--color-text-muted": "#6C5870",
      "--color-text-disabled": "#B3A3B6",
      "--color-text-link": "#9C2C6A",
      "--color-accent": "#B83280",
      "--color-accent-hover": "#962868",
      "--color-accent-text": "#9C2C6A",
      "--color-text-on-accent": "#FFFFFF",
      "--color-border": "#EAD8E6",
      "--color-border-control": "#8F7A93",
      "--color-focus": "#4F4FD0",
    },
    dark: {
      "--color-bg-rail": "#140E18",
      "--color-bg-sidebar": "#1A121F",
      "--color-bg": "#201726",
      "--color-bg-elevated": "#281D2F",
      "--color-bg-input": "#251B2B",
      "--color-bg-hover": "#2D2135",
      "--color-bg-selected": "#3A2B44",
      "--color-bg-mention": "#3A1A33",
      "--color-text": "#F7ECF7",
      "--color-text-muted": "#C0AAC5",
      "--color-text-disabled": "#76637B",
      "--color-text-link": "#FFA6D4",
      "--color-accent": "#FF8CC6",
      "--color-accent-hover": "#FFB0D8",
      "--color-accent-text": "#FFA6D4",
      "--color-text-on-accent": "#2A0A1C",
      "--color-border": "#3A2B44",
      "--color-border-control": "#806B87",
      "--color-focus": "#A5B4FF",
    },
    shadow: {
      light: "0 18px 40px -16px #B8328040, 0 2px 6px #2A1B2E14",
      dark: "0 18px 48px -16px #000000CC",
    },
    fx: {
      light: {
        "--fx-backdrop": "linear-gradient(135deg, #F6D5EA 0%, #E4DAFB 50%, #D3EEF4 100%)",
        "--fx-card-shadow": "0 10px 30px -14px #B8328059, 0 1px 3px #2A1B2E14",
      },
      dark: {
        "--fx-backdrop": "linear-gradient(135deg, #2E1433 0%, #1B1433 50%, #102330 100%)",
        "--fx-card-shadow": "0 14px 40px -16px #000000D9",
      },
    },
    props: {
      "--font-sans": ROUNDED,
      "--font-display": ROUNDED,
      "--tracking-display": "-0.01em",
      "--radius-sm": "6px",
      "--radius-md": "10px",
      "--radius-lg": "14px",
      "--radius-xl": "20px",
    },
  },

  // Neon on deep indigo: hot pink accent, cyan links, glowing panels and headings. Light is the vaporwave pastel.
  synthwave: {
    light: {
      "--color-bg-rail": "#E5D9FA",
      "--color-bg-sidebar": "#EEE5FD",
      "--color-bg": "#F8F3FF",
      "--color-bg-elevated": "#FFFFFF",
      "--color-bg-input": "#EDE4FC",
      "--color-bg-hover": "#EADFFB",
      "--color-bg-selected": "#DCCCF7",
      "--color-bg-mention": "#FFDFF0",
      "--color-text": "#1C1033",
      "--color-text-muted": "#5A4A7C",
      "--color-text-disabled": "#A99CC4",
      "--color-text-link": "#006A7E",
      "--color-accent": "#C2177F",
      "--color-accent-hover": "#9E1267",
      "--color-accent-text": "#A81370",
      "--color-text-on-accent": "#FFFFFF",
      "--color-border": "#DDD0F3",
      "--color-border-control": "#8875AD",
      "--color-focus": "#0060DF",
    },
    dark: {
      "--color-bg-rail": "#0A0614",
      "--color-bg-sidebar": "#0F0920",
      "--color-bg": "#140C2A",
      "--color-bg-elevated": "#1C1238",
      "--color-bg-input": "#180F31",
      "--color-bg-hover": "#221645",
      "--color-bg-selected": "#2E1D5C",
      "--color-bg-mention": "#3A1240",
      "--color-text": "#F4ECFF",
      "--color-text-muted": "#B8A8DA",
      "--color-text-disabled": "#6C5D91",
      "--color-text-link": "#3EE6FF",
      "--color-accent": "#FF3EA5",
      "--color-accent-hover": "#FF6BBC",
      "--color-accent-text": "#FF6BBC",
      "--color-text-on-accent": "#1A0012",
      "--color-border": "#2E1D5C",
      "--color-border-control": "#7B65B9",
      "--color-focus": "#FFE45E",
    },
    shadow: {
      light: "0 14px 34px -14px #C2177F4D",
      dark: "0 0 0 1px #FF3EA540, 0 0 36px -8px #FF3EA599",
    },
    fx: {
      light: {
        "--fx-sky": "linear-gradient(180deg, #F8F3FF 0%, #F6EDFF 55%, #FFE3F2 100%)",
        "--fx-heading-filter": "none",
        "--fx-grid": "#C2177F2E",
      },
      dark: {
        "--fx-sky": "linear-gradient(180deg, #140C2A 0%, #1A0D33 55%, #33103F 100%)",
        "--fx-heading-filter": "drop-shadow(0 0 10px #FF3EA5B3)",
        "--fx-grid": "#FF3EA540",
      },
    },
    props: {
      "--tracking-display": "0.03em",
      "--radius-sm": "2px",
      "--radius-md": "4px",
      "--radius-lg": "6px",
      "--radius-xl": "8px",
    },
  },

  // Cool and quiet: blue-grey slate, softly rounded corners, Inter throughout, light shadows.
  fjord: {
    light: {
      "--color-bg-rail": "#DCE2EA",
      "--color-bg-sidebar": "#E7ECF2",
      "--color-bg": "#F4F7FA",
      "--color-bg-elevated": "#FFFFFF",
      "--color-bg-input": "#E8EDF3",
      "--color-bg-hover": "#E2E8EF",
      "--color-bg-selected": "#D4DDE8",
      "--color-bg-mention": "#DFEBF7",
      "--color-text": "#1B2430",
      "--color-text-muted": "#4B596A",
      "--color-text-disabled": "#97A3B0",
      "--color-text-link": "#1D5A94",
      "--color-accent": "#2D6BA3",
      "--color-accent-hover": "#235684",
      "--color-accent-text": "#215D95",
      "--color-text-on-accent": "#FFFFFF",
      "--color-border": "#D2DBE5",
      "--color-border-control": "#7A8898",
      "--color-focus": "#7A3FD1",
    },
    dark: {
      "--color-bg-rail": "#151A21",
      "--color-bg-sidebar": "#1A2028",
      "--color-bg": "#202732",
      "--color-bg-elevated": "#272F3B",
      "--color-bg-input": "#242C37",
      "--color-bg-hover": "#2B3441",
      "--color-bg-selected": "#35404E",
      "--color-bg-mention": "#223A52",
      "--color-text": "#E6EDF4",
      "--color-text-muted": "#A5B3C4",
      "--color-text-disabled": "#627083",
      "--color-text-link": "#8FC6F5",
      "--color-accent": "#7DB6E0",
      "--color-accent-hover": "#A1CBEA",
      "--color-accent-text": "#93C5EC",
      "--color-text-on-accent": "#0C1A28",
      "--color-border": "#333D4A",
      "--color-border-control": "#728195",
      "--color-focus": "#D7A6FF",
    },
    shadow: {
      light: "0 10px 28px -12px #1B243029, 0 1px 2px #1B243014",
      dark: "0 14px 36px -12px #000000A6",
    },
    fx: {
      light: {
        "--fx-aurora":
          "radial-gradient(ellipse 120% 60% at 30% 0%, #9CC9E833, transparent 70%), radial-gradient(ellipse 90% 50% at 90% 0%, #B9A6E633, transparent 70%)",
        "--fx-header-shadow": "0 1px 0 #D2DBE5, 0 8px 18px -14px #1B243040",
      },
      dark: {
        "--fx-aurora":
          "radial-gradient(ellipse 120% 60% at 30% 0%, #3FB8A529, transparent 70%), radial-gradient(ellipse 90% 50% at 90% 0%, #8C6CE629, transparent 70%)",
        "--fx-header-shadow": "0 1px 0 #333D4A, 0 8px 18px -14px #000000B3",
      },
    },
    props: {
      "--font-display": FONTS.sans,
      "--tracking-display": "-0.015em",
      "--radius-sm": "4px",
      "--radius-md": "6px",
      "--radius-lg": "8px",
      "--radius-xl": "12px",
    },
  },

  // A poster: black on white, thick rules, hard offset shadows, ultramarine; dark is black with a yellow accent.
  brutalist: {
    light: {
      "--color-bg-rail": "#EBEBEB",
      "--color-bg-sidebar": "#F5F5F5",
      "--color-bg": "#FFFFFF",
      "--color-bg-elevated": "#FFFFFF",
      "--color-bg-input": "#F2F2F2",
      "--color-bg-hover": "#EFEFEF",
      "--color-bg-selected": "#FFE94D",
      "--color-bg-mention": "#FFF4B3",
      "--color-text": "#000000",
      "--color-text-muted": "#454545",
      "--color-text-disabled": "#9A9A9A",
      "--color-text-link": "#1A1AE6",
      "--color-accent": "#1A1AE6",
      "--color-accent-hover": "#0000B3",
      "--color-accent-text": "#1A1AE6",
      "--color-text-on-accent": "#FFFFFF",
      "--color-border": "#000000",
      "--color-border-control": "#000000",
      "--color-focus": "#D92B00",
    },
    dark: {
      "--color-bg-rail": "#000000",
      "--color-bg-sidebar": "#0A0A0A",
      "--color-bg": "#111111",
      "--color-bg-elevated": "#161616",
      "--color-bg-input": "#1A1A1A",
      "--color-bg-hover": "#202020",
      "--color-bg-selected": "#2E2E2E",
      "--color-bg-mention": "#34300A",
      "--color-text": "#FFFFFF",
      "--color-text-muted": "#BDBDBD",
      "--color-text-disabled": "#6E6E6E",
      "--color-text-link": "#FFE94D",
      "--color-accent": "#FFE94D",
      "--color-accent-hover": "#FFF38A",
      "--color-accent-text": "#FFE94D",
      "--color-text-on-accent": "#000000",
      "--color-border": "#EDEDED",
      "--color-border-control": "#FFFFFF",
      "--color-focus": "#FF6A45",
    },
    shadow: { light: "6px 6px 0 #000000", dark: "6px 6px 0 #FFE94D" },
    props: {
      "--tracking-display": "-0.04em",
      ...SQUARE,
    },
  },
};
