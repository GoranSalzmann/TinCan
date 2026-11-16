// SPDX-License-Identifier: AGPL-3.0-or-later
// The web client's page shell (index.html), served by the app for a few paths so that link previews in other apps
// (WhatsApp, Discord, Slack, iMessage) show something better than a bare URL. Their crawlers read Open Graph tags from
// the HTML and run no JavaScript, so the tags have to be in the page as served. Caddy serves the same file for every
// other path, and for these ones too when the app answers 404 (no shell file in this build).
import { readFileSync } from "node:fs";

/** What a preview shows. Values are plain text; `renderShell` escapes them. */
export interface PageMeta {
  title: string;
  description: string;
  /** Path of the page on the public origin, e.g. `/invite/abc`. */
  path: string;
}

/** The share card in the web build (apps/web/public/brand/og-image.png). */
export const SHARE_IMAGE = { path: "/brand/og-image.png", width: 1200, height: 630 } as const;

/** Reads the shell, or returns null when this build has none (development, or a server image without the web build). */
export function loadShell(file: string): string | null {
  try {
    const html = readFileSync(file, "utf8");
    return html.includes("</head>") ? html : null;
  } catch {
    return null;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for an HTML attribute value or element text. Community names are chosen by people, not by us. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

// The preview tags the static shell carries, which a rendered page replaces.
const PREVIEW_TAGS =
  /[ \t]*<meta\s+(?:name="(?:description|twitter:[^"]*)"|property="og:[^"]*")[^>]*>[ \t]*\r?\n?|[ \t]*<!--\s*Link previews[\s\S]*?-->[ \t]*\r?\n?/g;
const TITLE = /<title>[\s\S]*?<\/title>/;

/** The shell with `meta` as its title and preview tags. URLs are absolute on `publicUrl`, as Open Graph requires. */
export function renderShell(shell: string, meta: PageMeta, publicUrl: string, siteName: string): string {
  const origin = new URL(publicUrl).origin;
  const e = escapeHtml;
  const tags = [
    `<meta name="description" content="${e(meta.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${e(siteName)}" />`,
    `<meta property="og:title" content="${e(meta.title)}" />`,
    `<meta property="og:description" content="${e(meta.description)}" />`,
    `<meta property="og:url" content="${e(origin + meta.path)}" />`,
    `<meta property="og:image" content="${e(origin + SHARE_IMAGE.path)}" />`,
    `<meta property="og:image:width" content="${SHARE_IMAGE.width}" />`,
    `<meta property="og:image:height" content="${SHARE_IMAGE.height}" />`,
    `<meta property="og:image:alt" content="The Tin Can logo: two tin cans joined by a string" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ]
    .map((t) => `    ${t}\n`)
    .join("");
  const stripped = shell.replace(PREVIEW_TAGS, "");
  const titled = TITLE.test(stripped)
    ? stripped.replace(TITLE, () => `<title>${e(meta.title)}</title>`)
    : stripped.replace("</head>", () => `    <title>${e(meta.title)}</title>\n  </head>`);
  return titled.replace("</head>", () => `${tags}  </head>`);
}
