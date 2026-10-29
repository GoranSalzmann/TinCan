// SPDX-License-Identifier: AGPL-3.0-or-later
import { Fragment, useState, type ReactNode } from "react";

/**
 * Message rendering (12 §5.6): a small Markdown subset parsed into React elements. Nothing here ever
 * builds HTML from the text, so there is no sanitiser to get wrong: untrusted text can only become
 * text nodes, the fixed set of elements below, and links whose scheme is http, https or mailto.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del" | "spoiler"; c: Inline[] }
  | { t: "link"; href: string; label: string | null }
  | { t: "user" | "role" | "channel"; id: string }
  | { t: "everyone"; v: string };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] };

const URL_RE = /^https?:\/\/[^\s<>"']+/i;
const ID = "[0-9A-HJKMNP-TV-Z]{26}";
const USER_RE = new RegExp(`^<@(${ID})>`);
const ROLE_RE = new RegExp(`^<@&(${ID})>`);
const CHANNEL_RE = new RegExp(`^<#(${ID})>`);
const EVERYONE_RE = /^@(everyone|here)\b/;
const MD_LINK_RE = /^\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/i;

/** Characters a URL does not end in when it is followed by punctuation of the sentence. */
function trimUrl(url: string): string {
  return url.replace(/[.,;:!?)\]}'"]+$/, "");
}

/** Finds the closing marker for an opener at `from`, not crossing a blank line; null if none. */
function findClose(src: string, marker: string, from: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "`") {
      // a code span inside emphasis hides its contents from the search
      const end = src.indexOf("`", i + 1);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (src.startsWith(marker, i) && i > from) return i;
    i++;
  }
  return -1;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i]!;
    let m: RegExpExecArray | null;

    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch === "<" && (m = USER_RE.exec(rest))) {
      flush();
      out.push({ t: "user", id: m[1]! });
      i += m[0].length;
      continue;
    } else if (ch === "<" && (m = ROLE_RE.exec(rest))) {
      flush();
      out.push({ t: "role", id: m[1]! });
      i += m[0].length;
      continue;
    } else if (ch === "<" && (m = CHANNEL_RE.exec(rest))) {
      flush();
      out.push({ t: "channel", id: m[1]! });
      i += m[0].length;
      continue;
    } else if (ch === "@" && (m = EVERYONE_RE.exec(rest)) && (i === 0 || /\s|[(]/.test(src[i - 1]!))) {
      flush();
      out.push({ t: "everyone", v: m[0] });
      i += m[0].length;
      continue;
    } else if (ch === "[" && (m = MD_LINK_RE.exec(rest))) {
      flush();
      out.push({ t: "link", href: m[2]!, label: m[1]! });
      i += m[0].length;
      continue;
    } else if (
      (ch === "h" || ch === "H") &&
      (m = URL_RE.exec(rest)) &&
      (i === 0 || /[\s(]/.test(src[i - 1]!))
    ) {
      const url = trimUrl(m[0]);
      flush();
      out.push({ t: "link", href: url, label: null });
      i += url.length;
      continue;
    } else {
      const pairs: [string, "strong" | "em" | "del" | "spoiler"][] = [
        ["**", "strong"],
        ["~~", "del"],
        ["||", "spoiler"],
        ["*", "em"],
        ["_", "em"],
      ];
      let matched = false;
      for (const [marker, t] of pairs) {
        if (!rest.startsWith(marker)) continue;
        // `_` inside a word (snake_case) is not emphasis
        if (marker === "_" && i > 0 && /\w/.test(src[i - 1]!)) continue;
        const close = findClose(src, marker, i + marker.length);
        if (close > i + marker.length && !/^\s/.test(src.slice(i + marker.length, i + marker.length + 1))) {
          flush();
          out.push({ t, c: parseInline(src.slice(i + marker.length, close)) });
          i = close + marker.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(\w{0,20})\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j]!)) body.push(lines[j++]!);
      if (j < lines.length || body.length > 0) {
        flushPara();
        blocks.push({ t: "code", lang: fence[1] ?? "", v: body.join("\n") });
        i = j;
        continue;
      }
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const q: string[] = [line.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1]!)) q.push(lines[++i]!.replace(/^>\s?/, ""));
      blocks.push({ t: "quote", c: parseInline(q.join("\n")) });
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]!);
      const items: Inline[][] = [parseInline(li[3]!)];
      while (i + 1 < lines.length) {
        const next = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i + 1]!);
        if (!next || /\d/.test(next[2]!) !== ordered) break;
        items.push(parseInline(next[3]!));
        i++;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

// ---- links (12 §5.6): confirm when the visible destination differs from the real one -------------

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Safe schemes only; anything else is shown as plain text. */
export function safeHref(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

export interface LinkCheck {
  /** Needs the "Open this link?" confirmation (W-03). */
  suspicious: boolean;
  shownHost: string | null;
  realHost: string | null;
}

/** A link is suspicious when its text looks like a different address than where it goes, or the host is an IDN. */
export function checkLink(href: string, label: string | null): LinkCheck {
  const realHost = hostOf(href);
  const labelUrl =
    label && /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(label.trim()) ? label.trim() : null;
  const shownHost = labelUrl ? hostOf(/^https?:/i.test(labelUrl) ? labelUrl : `https://${labelUrl}`) : null;
  const idn =
    realHost !== null &&
    (realHost.split(".").some((p) => p.startsWith("xn--")) ||
      [...realHost].some((ch) => ch.charCodeAt(0) > 127));
  const differs =
    shownHost !== null &&
    realHost !== null &&
    shownHost.replace(/^www\./, "") !== realHost.replace(/^www\./, "");
  return { suspicious: idn || differs, shownHost, realHost };
}

// ---- rendering -------------------------------------------------------------------------------------

export interface RenderContext {
  userName(id: string): string;
  roleName(id: string): string | null;
  channelName(id: string): string | null;
  selfId: string;
  selfRoleIds: readonly string[];
  openChannel(id: string): void;
  openLink(href: string, check: LinkCheck): void;
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={shown ? undefined : "Spoiler, activate to show"}
      onClick={() => setShown(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") setShown(true);
      }}
      className={
        shown ? "rounded-sm bg-bg-hover" : "cursor-pointer rounded-sm bg-text text-transparent select-none"
      }
    >
      {children}
    </span>
  );
}

const chip = "rounded-sm bg-bg-mention px-1 font-medium text-text";

function InlineView({ nodes, ctx }: { nodes: Inline[]; ctx: RenderContext }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{n.v}</Fragment>;
      case "code":
        return (
          <code key={i} className="rounded-sm bg-bg-input px-1 font-mono text-[0.9em]">
            {n.v}
          </code>
        );
      case "strong":
        return (
          <strong key={i}>
            <InlineView nodes={n.c} ctx={ctx} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <InlineView nodes={n.c} ctx={ctx} />
          </em>
        );
      case "del":
        return (
          <del key={i}>
            <InlineView nodes={n.c} ctx={ctx} />
          </del>
        );
      case "spoiler":
        return (
          <Spoiler key={i}>
            <InlineView nodes={n.c} ctx={ctx} />
          </Spoiler>
        );
      case "user":
        return (
          <span
            key={i}
            className={`${chip} ${n.id === ctx.selfId ? "outline outline-1 outline-border-control" : ""}`}
          >
            @{ctx.userName(n.id)}
          </span>
        );
      case "role": {
        const name = ctx.roleName(n.id);
        return (
          <span key={i} className={chip}>
            @{name ?? "deleted-role"}
          </span>
        );
      }
      case "everyone":
        return (
          <span key={i} className={chip}>
            {n.v}
          </span>
        );
      case "channel": {
        const name = ctx.channelName(n.id);
        return name ? (
          <button
            key={i}
            type="button"
            onClick={() => ctx.openChannel(n.id)}
            className={`${chip} cursor-pointer border-0 text-start`}
          >
            #{name}
          </button>
        ) : (
          <span key={i} className={chip}>
            #unknown
          </span>
        );
      }
      case "link": {
        const href = safeHref(n.href);
        if (!href) return <Fragment key={i}>{n.label ?? n.href}</Fragment>;
        const check = checkLink(href, n.label);
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => {
              e.preventDefault();
              ctx.openLink(href, check);
            }}
          >
            {n.label ?? n.href}
          </a>
        );
      }
    }
  });
}

export function Markdown({ text, ctx }: { text: string; ctx: RenderContext }) {
  const blocks = parseBlocks(text);
  return (
    <div className="break-words [overflow-wrap:anywhere]">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return (
              <p key={i} className="whitespace-pre-wrap">
                <InlineView nodes={b.c} ctx={ctx} />
              </p>
            );
          case "code":
            return (
              <pre
                key={i}
                data-lang={b.lang || undefined}
                className="my-1 max-w-full overflow-x-auto rounded-md bg-bg-input p-2 font-mono text-sm"
              >
                <code>{b.v}</code>
              </pre>
            );
          case "quote":
            return (
              <blockquote
                key={i}
                className="my-1 border-s-4 border-border-control ps-3 whitespace-pre-wrap text-text-muted"
              >
                <InlineView nodes={b.c} ctx={ctx} />
              </blockquote>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i} className={`my-1 ps-6 ${b.ordered ? "list-decimal" : "list-disc"}`}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <InlineView nodes={item} ctx={ctx} />
                  </li>
                ))}
              </Tag>
            );
          }
        }
      })}
    </div>
  );
}
