// SPDX-License-Identifier: AGPL-3.0-or-later

/** How much of a text file is kept for the preview (23 §7). */
export const EXCERPT_MAX_LINES = 8;
export const EXCERPT_MAX_CHARS = 600;
/** The only part of a file that is read to make an excerpt. */
export const EXCERPT_SAMPLE_BYTES = 4096;

const TEXT_EXTENSIONS = new Set(
  (
    "txt text md markdown rst csv tsv json jsonl ndjson log xml html htm xhtml svg yml yaml toml ini cfg conf env " +
    "css scss less js mjs cjs ts tsx jsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh ps1 bat sql " +
    "lua pl r tex srt vtt diff patch gitignore dockerfile makefile"
  ).split(" "),
);

/** Whether a file is *expected* to be text: by extension, or by a declared text type. The bytes still decide. */
export function looksLikeText(filename: string, declaredType: string | undefined): boolean {
  const t = (declaredType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    t.startsWith("text/") ||
    t === "application/json" ||
    t.endsWith("+json") ||
    t === "application/x-ndjson"
  )
    return true;
  const base = filename.toLowerCase();
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
  return TEXT_EXTENSIONS.has(ext);
}

/** Zero-width and bidirectional controls that can make text read differently from how it is stored. */
const SPOOFING = /[​-‏‪-‮⁦-⁩﻿]/g;

/** Decodes a sample as text, or returns null when it is binary or in an encoding we do not guess. */
function decode(sample: Buffer, cut: boolean): string | null {
  let buf = sample;
  let label: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  else if (buf[0] === 0xff && buf[1] === 0xfe) {
    label = "utf-16le";
    buf = buf.subarray(2);
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    label = "utf-16be";
    buf = buf.subarray(2);
  } else if (buf.length >= 4) {
    // BOM-less UTF-16 of mostly ASCII text: nearly every second byte is zero.
    let even = 0;
    let odd = 0;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      if (buf[i] === 0) even++;
      if (buf[i + 1] === 0) odd++;
    }
    const pairs = Math.floor(buf.length / 2);
    if (odd > pairs * 0.9 && even === 0) label = "utf-16le";
    else if (even > pairs * 0.9 && odd === 0) label = "utf-16be";
  }
  if (label === "utf-8") {
    if (buf.includes(0)) return null;
    // A multi-byte character cut by the end of the sample is not an error.
    if (cut) {
      let end = buf.length;
      for (let back = 1; back <= 3 && end - back >= 0; back++) {
        const b = buf[end - back]!;
        if ((b & 0xc0) === 0x80) continue;
        if (b >= 0xc0) end = end - back;
        break;
      }
      buf = buf.subarray(0, end);
    }
  } else {
    if (buf.length % 2 === 1) buf = buf.subarray(0, buf.length - 1);
    if (label === "utf-16be") {
      const swapped = Buffer.from(buf);
      swapped.swap16();
      buf = swapped;
    }
  }
  let text: string;
  try {
    text = new TextDecoder(label === "utf-16be" ? "utf-16le" : label, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
  let control = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) || c === 127 || c === 0xfffd) control++;
  }
  if (text.length > 0 && control / text.length > 0.1) return null;
  return text;
}

export interface Excerpt {
  text: string;
  truncated: boolean;
}

/**
 * The first lines of a text sample, as plain text, or null if it is not text. `fileSize` tells whether more follows
 * the sample. The result is only ever shown as an escaped text node; it is never parsed or run.
 */
export function makeExcerpt(sample: Buffer, fileSize: number): Excerpt | null {
  const cut = fileSize > sample.length;
  const decoded = decode(sample, cut);
  if (decoded === null) return null;
  const clean = decoded
    .replace(/\r\n?/g, "\n")
    .replace(SPOOFING, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lines = clean.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  let text = lines.slice(0, EXCERPT_MAX_LINES).join("\n");
  let truncated = cut || lines.length > EXCERPT_MAX_LINES;
  const chars = [...text];
  if (chars.length > EXCERPT_MAX_CHARS) {
    text = chars.slice(0, EXCERPT_MAX_CHARS).join("");
    truncated = true;
  }
  return { text, truncated };
}
