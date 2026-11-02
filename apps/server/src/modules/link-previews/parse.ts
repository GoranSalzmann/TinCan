// SPDX-License-Identifier: AGPL-3.0-or-later

export const TITLE_MAX = 150;
export const DESCRIPTION_MAX = 300;
export const SITE_NAME_MAX = 60;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  middot: "·",
  bull: "•",
};

/** Decodes the character references that matter in titles and descriptions, once. Unknown ones stay as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1]?.toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return " ";
      return String.fromCodePoint(code);
    }
    return NAMED[ref.toLowerCase()] ?? all;
  });
}

/** Controls, zero-width characters and bidirectional overrides: nothing a preview needs, and some can mislead. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/**
 * Turns text from a third-party page into one short plain line: tags dropped, references decoded, whitespace
 * collapsed, invisible characters removed, cut to `max` characters. The result is only ever shown as a text node.
 */
export function cleanText(raw: string | null | undefined, max: number): string | null {
  if (!raw) return null;
  const noTags = raw.replace(/<[^>]*>/g, " ");
  const text = decodeEntities(noTags).replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

/** Like `cleanText` but keeps line breaks that the source marks with `<br>` or paragraphs (oEmbed posts). */
export function plainTextFromHtml(html: string, max: number): string | null {
  return cleanText(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>/gi, " ")
      // Drop the footer lines of an embedded post ("— Name (@handle) date"): they live after the blockquote text.
      .replace(/&mdash;[^<]*<a[\s\S]*$/i, " "),
    max,
  );
}

/** Attributes of one tag, names lower-cased. Values are raw (entities are decoded by the caller). */
function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const body = tag.replace(/^<\w+/, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(re)) {
    const name = m[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export interface PageMeta {
  /** `og:*` and `twitter:*` and `description`, keyed by their names. */
  meta: Map<string, string>;
  title: string | null;
  /** Where the page says its oEmbed JSON is, if it does. */
  oembedHref: string | null;
}

/** Reads the head of an HTML page. Scripts, styles and comments are cut first; nothing is evaluated. */
export function parseHead(html: string): PageMeta {
  let src = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  const end = src.search(/<\/head\s*>|<body\b/i);
  if (end >= 0) src = src.slice(0, end);
  const meta = new Map<string, string>();
  let oembedHref: string | null = null;
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.get("property") ?? a.get("name") ?? "").toLowerCase();
    const content = a.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  for (const m of src.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const type = (a.get("type") ?? "").toLowerCase();
    if (
      (a.get("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate") &&
      type === "application/json+oembed"
    )
      oembedHref ??= a.get("href") ?? null;
  }
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(src);
  return { meta, title: t ? cleanText(t[1], TITLE_MAX) : null, oembedHref };
}

/** An absolute http(s) URL from a possibly relative value, or null. */
export function absoluteHttpUrl(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(decodeEntities(value).trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Decodes a page body with its declared charset when the platform knows it, UTF-8 otherwise. */
export function decodeBody(body: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

export interface Unfurled {
  siteName: string | null;
  title: string | null;
  description: string | null;
  /** Absolute URL of the image to fetch and re-host. */
  imageUrl: string | null;
  video: boolean;
}

/** What the Open Graph and Twitter-card tags (then `<title>` and the plain description) say about a page. */
export function fromMeta(page: PageMeta, pageUrl: string): Unfurled {
  const m = (k: string) => page.meta.get(k);
  const host = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();
  const type = (m("og:type") ?? "").toLowerCase();
  return {
    siteName: cleanText(m("og:site_name"), SITE_NAME_MAX) ?? host,
    title: cleanText(m("og:title") ?? m("twitter:title") ?? page.title, TITLE_MAX),
    description: cleanText(
      m("og:description") ?? m("twitter:description") ?? m("description"),
      DESCRIPTION_MAX,
    ),
    imageUrl: absoluteHttpUrl(
      m("og:image") ?? m("og:image:url") ?? m("twitter:image") ?? m("twitter:image:src"),
      pageUrl,
    ),
    video: type.startsWith("video") || m("twitter:card") === "player",
  };
}
