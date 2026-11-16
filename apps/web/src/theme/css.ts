// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  COLOR_TOKENS,
  FONTS,
  SHADOW_ELEV,
  SKIN_NAMES,
  SKINS,
  type SkinName,
  type ThemeName,
} from "./tokens.js";

/**
 * Generates tokens.generated.css from tokens.ts (style guide §16). `pnpm --filter @tincan/web gen:tokens`
 * rewrites the file; `theme.test.ts` fails when it is stale.
 */

/** Style guide §5.2: size, line height, weight. */
const TYPE_SCALE: [string, string, string, number][] = [
  ["xs", "0.75rem", "1rem", 500],
  ["sm", "0.8125rem", "1.125rem", 400],
  ["base", "0.9375rem", "1.375rem", 400],
  ["lg", "1.0625rem", "1.5rem", 600],
  ["xl", "1.25rem", "1.75rem", 600],
  ["2xl", "1.5rem", "2rem", 700],
];

/** Style guide §7: near-square corners everywhere; only shapes that carry meaning (presence, switch) stay round. */
const RADII: [string, string][] = [
  ["sm", "1px"],
  ["md", "2px"],
  ["lg", "2px"],
  ["xl", "3px"],
  ["full", "9999px"],
];

/** Style guide §6, §8, §9: layout, stacking and motion tokens that are not colours. */
const PLAIN_TOKENS: [string, string][] = [
  ["--size-rail", "4.5rem"],
  ["--size-sidebar", "17rem"],
  ["--size-members", "17rem"],
  ["--size-header", "3rem"],
  ["--size-user-panel", "3.25rem"],
  ["--size-target", "1.5rem"],
  ["--size-dialog-sm", "27.5rem"],
  ["--size-dialog-md", "36rem"],
  ["--size-content-max", "46rem"],
  ["--tracking-display", "-0.02em"],
  ["--z-sticky", "10"],
  ["--z-banner", "20"],
  ["--z-overlay", "40"],
  ["--z-modal", "50"],
  ["--z-popover", "60"],
  ["--z-toast", "70"],
  ["--z-tooltip", "80"],
  ["--duration-fast", "100ms"],
  ["--duration-base", "160ms"],
  ["--duration-slow", "240ms"],
  ["--ease-enter", "cubic-bezier(0, 0, 0.2, 1)"],
  ["--ease-exit", "cubic-bezier(0.4, 0, 1, 1)"],
  ["--ease-move", "cubic-bezier(0.2, 0, 0, 1)"],
];

const THEME_INDEX: Record<ThemeName, 1 | 2 | 3> = { light: 1, dark: 2, hc: 3 };

function declarations(theme: ThemeName, indent = "  "): string {
  const i = THEME_INDEX[theme];
  const lines = COLOR_TOKENS.map((row) => `${indent}${row[0]}: ${row[i]};`);
  lines.push(`${indent}--shadow-elev: ${SHADOW_ELEV[i - 1]};`);
  return `${indent}color-scheme: ${theme === "light" ? "light" : "dark"};\n${lines.join("\n")}`;
}

/**
 * A skin's colours and shadow for one mode. Every block sets the same keys, so the light block (which also matches a
 * dark root through `:root`) never leaks a value into dark.
 */
function skinDeclarations(name: SkinName, theme: "light" | "dark", indent: string): string {
  const skin = SKINS[name];
  const lines = Object.entries(skin[theme]).map(([k, v]) => `${indent}${k}: ${v};`);
  lines.push(`${indent}--shadow-elev: ${skin.shadow[theme]};`);
  for (const [k, v] of Object.entries(skin.fx?.[theme] ?? {})) lines.push(`${indent}${k}: ${v};`);
  return lines.join("\n");
}

export function renderTokensCss(): string {
  const out: string[] = [];
  out.push(
    "/* Generated from src/theme/tokens.ts by `pnpm --filter @tincan/web gen:tokens`. Do not edit. */",
    "",
  );

  // Tailwind theme: semantic names only. Clearing the default palette means raw classes such as bg-gray-800 cannot exist.
  out.push("@theme {", "  --color-*: initial;");
  for (const row of COLOR_TOKENS) out.push(`  ${row[0]}: ${row[1]};`);
  out.push(
    `  --font-sans: ${FONTS.sans};`,
    `  --font-display: ${FONTS.display};`,
    `  --font-mono: ${FONTS.mono};`,
  );
  for (const [n, size, lh, weight] of TYPE_SCALE) {
    out.push(
      `  --text-${n}: ${size};`,
      `  --text-${n}--line-height: ${lh};`,
      `  --text-${n}--font-weight: ${weight};`,
    );
  }
  for (const [n, v] of RADII) out.push(`  --radius-${n}: ${v};`);
  out.push("}", "");

  out.push("/* Plain tokens */", ":root {");
  for (const [n, v] of PLAIN_TOKENS) out.push(`  ${n}: ${v};`);
  out.push("}", "");

  out.push("/* One block per theme (style guide §2). `data-theme` is set by the Appearance setting. */");
  out.push(`:root,\n[data-theme="light"] {\n${declarations("light")}\n}`);
  out.push(`[data-theme="dark"] {\n${declarations("dark")}\n}`);
  out.push(`[data-theme="hc"] {\n${declarations("hc")}\n}`, "");

  out.push(
    "/* System preference before any setting is loaded (the CSP forbids an inline script to set data-theme). */",
  );
  out.push(
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme]) {\n${declarations("dark", "    ")}\n  }\n}`,
  );
  out.push(
    `@media (prefers-contrast: more) {\n  :root:not([data-theme]) {\n${declarations("hc", "    ")}\n  }\n}`,
    "",
  );

  out.push(
    "/* Themes (style guide §3.2). `data-skin` is set by the Appearance setting, never in high contrast. */",
  );
  for (const name of SKIN_NAMES) {
    if (name === "ember") continue; // the default values above
    const sel = `[data-skin="${name}"]`;
    const props = Object.entries(SKINS[name].props).map(([k, v]) => `  ${k}: ${v};`);
    if (props.length) out.push(`${sel} {\n${props.join("\n")}\n}`);
    out.push(`${sel}:is(:root, [data-theme="light"]) {\n${skinDeclarations(name, "light", "  ")}\n}`);
    out.push(`${sel}[data-theme="dark"] {\n${skinDeclarations(name, "dark", "  ")}\n}`);
    out.push(
      `@media (prefers-color-scheme: dark) {\n  ${sel}:root:not([data-theme]) {\n${skinDeclarations(name, "dark", "    ")}\n  }\n}`,
    );
  }
  out.push("");

  out.push(
    "/* Windows contrast themes: tokens give way to system colours (style guide §2). */",
    "@media (forced-colors: active) {",
    "  :root {",
    "    --color-bg-rail: Canvas;",
    "    --color-bg-sidebar: Canvas;",
    "    --color-bg: Canvas;",
    "    --color-bg-elevated: Canvas;",
    "    --color-bg-input: Canvas;",
    "    --color-text: CanvasText;",
    "    --color-text-muted: CanvasText;",
    "    --color-text-link: LinkText;",
    "    --color-accent: Highlight;",
    "    --color-accent-hover: Highlight;",
    "    --color-accent-text: LinkText;",
    "    --color-text-on-accent: HighlightText;",
    "    --color-border: CanvasText;",
    "    --color-border-control: ButtonText;",
    "    --color-focus: Highlight;",
    "    --color-bg-selected: Highlight;",
    "  }",
    "}",
    "",
  );
  return out.join("\n");
}
