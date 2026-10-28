// SPDX-License-Identifier: AGPL-3.0-or-later

const ACCENTED: Record<string, string> = {
  a: "á",
  b: "ƀ",
  c: "ç",
  d: "đ",
  e: "é",
  f: "ƒ",
  g: "ĝ",
  h: "ĥ",
  i: "í",
  j: "ĵ",
  k: "ķ",
  l: "ļ",
  m: "ɱ",
  n: "ñ",
  o: "ó",
  p: "ƥ",
  q: "ǫ",
  r: "ŕ",
  s: "š",
  t: "ţ",
  u: "ú",
  v: "ṽ",
  w: "ŵ",
  x: "ẋ",
  y: "ý",
  z: "ž",
  A: "Á",
  B: "Ɓ",
  C: "Ç",
  D: "Ď",
  E: "É",
  F: "Ƒ",
  G: "Ĝ",
  H: "Ĥ",
  I: "Í",
  J: "Ĵ",
  K: "Ķ",
  L: "Ļ",
  M: "Ṁ",
  N: "Ñ",
  O: "Ó",
  P: "Ƥ",
  Q: "Ǫ",
  R: "Ŕ",
  S: "Š",
  T: "Ţ",
  U: "Ú",
  V: "Ṽ",
  W: "Ŵ",
  X: "Ẋ",
  Y: "Ý",
  Z: "Ž",
};

const RLE = "‫";
const PDF = "‬";

/**
 * Dev-only pseudo-locales (style guide §12). `en-XA` accents every letter and pads the text by about
 * 40 % so clipping shows up. `ar-XB` keeps the letters and wraps the text as right-to-left so
 * mirroring and bidi bugs show up. Applied to the already formatted text, so plurals are resolved.
 */
export function pseudoLocalize(text: string, locale: string): string {
  if (locale === "ar-XB") return `${RLE}${text}${PDF}`;
  const accented = [...text].map((ch) => ACCENTED[ch] ?? ch).join("");
  const pad = "~".repeat(Math.max(2, Math.ceil(text.length * 0.4)));
  return `[${accented} ${pad}]`;
}
