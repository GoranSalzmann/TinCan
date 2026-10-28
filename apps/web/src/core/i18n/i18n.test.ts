// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./en.json";
import { directionOf, format } from "./index.js";
import { pseudoLocalize } from "./pseudo.js";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe("catalog", () => {
  const root = join(import.meta.dirname, "../..");

  it("has every key the code asks for", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bt\(\s*"([a-z][A-Za-z.]+)"/g)) {
        if (!(m[1]! in en)) missing.push(`${file}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("names every key module.area.name (style guide §12)", () => {
    for (const key of Object.keys(en)) expect(key, key).toMatch(/^[a-z]+(\.[A-Za-z0-9_]+)+$/);
  });

  it("holds whole sentences with ICU placeholders, never concatenated fragments", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), key).not.toBe("");
      expect(value, key).not.toMatch(/\s$/);
    }
  });
});

describe("format", () => {
  it("formats ICU plurals", () => {
    expect(format("en", "layout.members.count", { count: 1 })).toBe("1 member");
    expect(format("en", "layout.members.count", { count: 2 })).toBe("2 members");
    expect(format("en", "login.rateLimited", { seconds: 1 })).toBe(
      "Too many attempts. Try again in 1 second.",
    );
    expect(format("en", "login.rateLimited", { seconds: 30 })).toBe(
      "Too many attempts. Try again in 30 seconds.",
    );
  });

  it("returns the key itself for an unknown key so a gap is visible", () => {
    expect(format("en", "nope.nothing")).toBe("nope.nothing");
  });

  it("pseudo-localises: en-XA accents and lengthens, ar-XB marks the text right-to-left", () => {
    const base = format("en", "login.submit");
    const xa = format("en-XA", "login.submit");
    expect(xa).toMatch(/^\[.+\]$/);
    expect(xa).not.toContain("Log in");
    expect(xa.length).toBeGreaterThanOrEqual(Math.ceil(base.length * 1.4));
    expect(format("ar-XB", "login.submit")).toBe(`‫${base}‬`);
    expect(pseudoLocalize("Hi", "en-XA").length).toBeGreaterThan(2);
    expect(directionOf("ar-XB")).toBe("rtl");
    expect(directionOf("en-XA")).toBe("ltr");
  });
});
