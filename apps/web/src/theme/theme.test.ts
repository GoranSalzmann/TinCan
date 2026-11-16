// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderTokensCss } from "./css.js";
import { COLOR_TOKENS, SKIN_NAMES, SKINS } from "./tokens.js";

const doc = readFileSync(join(import.meta.dirname, "../../../../docs/design/style-guide.md"), "utf8");
const generated = readFileSync(join(import.meta.dirname, "tokens.generated.css"), "utf8");

const THEMES = ["light", "dark", "hc"] as const;
const tokenMap = (i: 1 | 2 | 3) => new Map(COLOR_TOKENS.map((r) => [r[0], r[i]]));

/** WCAG 2.2 relative luminance and contrast ratio. */
function parse(hex: string): { rgb: [number, number, number]; a: number } {
  const h = hex.replace("#", "");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], a: h.length === 8 ? n(6) / 255 : 1 };
}
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(fg: [number, number, number], bg: [number, number, number]): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}
/** A translucent background is judged over both white and black content, the worse of the two. */
function contrast(fgHex: string, bgHex: string): number {
  const fg = parse(fgHex).rgb;
  const bg = parse(bgHex);
  if (bg.a === 1) return ratio(fg, bg.rgb);
  const over = (base: number): [number, number, number] =>
    bg.rgb.map((c) => Math.round(c * bg.a + base * (1 - bg.a))) as [number, number, number];
  return Math.min(ratio(fg, over(255)), ratio(fg, over(0)));
}

describe("tokens.ts matches the approved style guide (§3)", () => {
  const rows = [
    ...doc
      .slice(doc.indexOf("## 3. Colour tokens"), doc.indexOf("### 3.1 Contrast pairings"))
      .matchAll(/^\| `(--color-[a-z-]+)` \| `(#\w+)` \| `(#\w+)` \| `(#\w+)` \|/gm),
  ];

  it("has every token of the table, with the same values", () => {
    expect(rows.length).toBe(COLOR_TOKENS.length);
    for (const [, name, light, dark, hc] of rows) {
      const ours = COLOR_TOKENS.find((r) => r[0] === name);
      expect(ours, name).toBeDefined();
      expect([ours![1], ours![2], ours![3]], name).toEqual([
        light!.toUpperCase(),
        dark!.toUpperCase(),
        hc!.toUpperCase(),
      ]);
    }
  });

  it("lists every theme in §3.2", () => {
    const sec = doc.slice(doc.indexOf("### 3.2 Themes"), doc.indexOf("## 4. State without colour"));
    const names = [...sec.matchAll(/^\| \*\*(\w+)\*\* \|/gm)].map((m) => m[1]!.toLowerCase());
    expect(names).toEqual([...SKIN_NAMES]);
  });
});

describe("contrast (WCAG 2.2 AA, style guide §3.1)", () => {
  const sec = doc.slice(doc.indexOf("### 3.1 Contrast pairings"), doc.indexOf("<!-- contrast:begin -->"));
  const pairings = [
    ...sec.matchAll(/^\| `(--color-[a-z-]+)` \| `(--color-[a-z-]+)` \| (\d(?:\.\d)?) \|/gm),
  ].map((m) => ({
    fg: m[1]!,
    bg: m[2]!,
    min: Number(m[3]),
  }));

  it("reads the pairing table", () => {
    expect(pairings.length).toBeGreaterThan(60);
  });

  it.each(THEMES)("every pairing meets its minimum in the %s theme", (theme) => {
    const i = (THEMES.indexOf(theme) + 1) as 1 | 2 | 3;
    const t = tokenMap(i);
    const failures: string[] = [];
    for (const p of pairings) {
      const fg = t.get(p.fg);
      const bg = t.get(p.bg);
      if (!fg || !bg) {
        failures.push(`${p.fg} on ${p.bg}: unknown token`);
        continue;
      }
      const r = contrast(fg, bg);
      if (r < p.min) failures.push(`${p.fg} on ${p.bg}: ${r.toFixed(2)} < ${p.min}`);
    }
    expect(failures).toEqual([]);
  });

  it("high contrast text reaches 7:1 on the page surfaces", () => {
    const t = tokenMap(3);
    for (const bg of ["--color-bg", "--color-bg-sidebar"]) {
      for (const fg of ["--color-text", "--color-text-muted", "--color-text-link"]) {
        expect(contrast(t.get(fg)!, t.get(bg)!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("ember is the token table", () => {
    expect(SKINS.ember.light).toEqual(Object.fromEntries(tokenMap(1)));
    expect(SKINS.ember.dark).toEqual(Object.fromEntries(tokenMap(2)));
  });

  it.each(SKIN_NAMES.flatMap((n) => (["light", "dark"] as const).map((m) => [n, m] as const)))(
    "every pairing meets its minimum in the %s theme, %s",
    (name, mode) => {
      const t = tokenMap(mode === "light" ? 1 : 2);
      for (const [k, v] of Object.entries(SKINS[name][mode])) t.set(k, v);
      const failures: string[] = [];
      for (const p of pairings) {
        const r = contrast(t.get(p.fg)!, t.get(p.bg)!);
        if (r < p.min) failures.push(`${p.fg} on ${p.bg}: ${r.toFixed(2)} < ${p.min}`);
      }
      expect(failures).toEqual([]);
    },
  );

  it("every theme sets only known tokens", () => {
    const known = new Set(COLOR_TOKENS.map((r) => r[0]));
    for (const name of SKIN_NAMES) {
      for (const mode of ["light", "dark"] as const) {
        for (const k of Object.keys(SKINS[name][mode]))
          expect(known.has(k), `${name} ${mode} ${k}`).toBe(true);
      }
    }
  });
});

describe("generated CSS", () => {
  it("is up to date (run `pnpm --filter @tincan/web gen:tokens`)", () => {
    expect(generated.replace(/\r\n/g, "\n")).toBe(renderTokensCss());
  });

  it("declares a block per theme, system fallbacks for first paint, and forced colours", () => {
    expect(generated).toContain(':root,\n[data-theme="light"]');
    expect(generated).toContain('[data-theme="dark"]');
    expect(generated).toContain('[data-theme="hc"]');
    expect(generated).toContain("@media (prefers-color-scheme: dark)");
    expect(generated).toContain("@media (forced-colors: active)");
    expect(generated).toContain("--color-*: initial;");
  });
});
