// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown, checkLink, parseBlocks, parseInline, safeHref, type RenderContext } from "./markdown.js";

const USER = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ROLE = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CHAN = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  userName: (id) => (id === USER ? "Ann" : "Deleted User"),
  roleName: (id) => (id === ROLE ? "Mods" : null),
  channelName: (id) => (id === CHAN ? "general" : null),
  selfId: "me",
  selfRoleIds: [],
  openChannel: vi.fn(),
  openLink: vi.fn(),
  ...over,
});

const html = (text: string, c = ctx()) => render(<Markdown text={text} ctx={c} />).container;

describe("inline parsing", () => {
  it("handles bold, italic, strike, code and nesting", () => {
    expect(parseInline("a **b** *c* ~~d~~ `e`")).toEqual([
      { t: "text", v: "a " },
      { t: "strong", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "c" }] },
      { t: "text", v: " " },
      { t: "del", c: [{ t: "text", v: "d" }] },
      { t: "text", v: " " },
      { t: "code", v: "e" },
    ]);
    expect(parseInline("**bold *and italic***")[0]).toMatchObject({ t: "strong" });
  });

  it("does not parse inside code, and leaves unmatched markers alone", () => {
    expect(parseInline("`**no**`")).toEqual([{ t: "code", v: "**no**" }]);
    expect(parseInline("2 * 3 = 6")).toEqual([{ t: "text", v: "2 * 3 = 6" }]);
    expect(parseInline("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
    expect(parseInline("**unclosed")).toEqual([{ t: "text", v: "**unclosed" }]);
  });

  it("recognises mention tokens, @everyone and links", () => {
    const nodes = parseInline(`hi <@${USER}> <@&${ROLE}> <#${CHAN}> @everyone see https://example.com/a.`);
    expect(nodes.map((n) => n.t)).toEqual([
      "text",
      "user",
      "text",
      "role",
      "text",
      "channel",
      "text",
      "everyone",
      "text",
      "link",
      "text",
    ]);
    const link = nodes.at(-2);
    expect(link).toMatchObject({ t: "link", href: "https://example.com/a", label: null });
    expect(parseInline("mail@everyone.com")).toEqual([{ t: "text", v: "mail@everyone.com" }]);
  });
});

describe("blocks", () => {
  it("splits fenced code, quotes, lists and paragraphs", () => {
    const blocks = parseBlocks(
      "intro\n```ts\nconst a = **1**\n```\n> quoted\n> more\n- one\n- two\n1. first",
    );
    expect(blocks.map((b) => b.t)).toEqual(["p", "code", "quote", "list", "list"]);
    expect(blocks[1]).toMatchObject({ t: "code", lang: "ts", v: "const a = **1**" });
    expect(blocks[3]).toMatchObject({ t: "list", ordered: false });
    expect(blocks[4]).toMatchObject({ t: "list", ordered: true });
  });

  it("keeps an unterminated fence as code to the end rather than losing the text", () => {
    expect(parseBlocks("```\nstill code")[0]).toMatchObject({ t: "code", v: "still code" });
  });
});

describe("untrusted text can only become text", () => {
  it("never produces markup from HTML", () => {
    const c = html("<script>alert(1)</script><img src=x onerror=alert(1)> <b>x</b>");
    expect(c.querySelector("script")).toBeNull();
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("b")).toBeNull();
    expect(c.textContent).toContain("<script>alert(1)</script>");
  });

  it("does not link dangerous schemes, in either link form", () => {
    for (const text of [
      "[x](javascript:alert(1))",
      "javascript:alert(1)",
      "[x](data:text/html,<script>1</script>)",
      "[x](vbscript:1)",
    ]) {
      expect(html(text).querySelector("a"), text).toBeNull();
    }
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
  });

  it("opens links without opener or referrer, and through the handler", () => {
    const openLink = vi.fn();
    const c = html("see https://example.com/page", ctx({ openLink }));
    const a = c.querySelector("a")!;
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(a.getAttribute("target")).toBe("_blank");
    fireEvent.click(a);
    expect(openLink).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({ suspicious: false }),
    );
  });

  it("flags lookalike and IDN links for confirmation", () => {
    expect(checkLink("https://xn--pypal-4ve.com/", "paypal.com")).toMatchObject({ suspicious: true });
    expect(checkLink("https://evil.example/", "https://paypal.com")).toMatchObject({ suspicious: true });
    expect(checkLink("https://www.example.com/a", "example.com/a")).toMatchObject({ suspicious: false });
    expect(checkLink("https://example.com/a", "click here")).toMatchObject({ suspicious: false });
    expect(checkLink("https://пример.рф/", null)).toMatchObject({ suspicious: true });
    const openLink = vi.fn();
    fireEvent.click(html("[paypal.com](https://evil.example/login)", ctx({ openLink })).querySelector("a")!);
    expect(openLink.mock.calls[0]![1]).toMatchObject({ suspicious: true, realHost: "evil.example" });
  });
});

describe("a battery of known XSS payloads (S-06, 15 §4.3)", () => {
  const payloads = [
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "<svg onload=alert(1)>",
    "<iframe src=javascript:alert(1)></iframe>",
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[click](vbscript:msgbox(1))",
    "[click](  javascript:alert(1))",
    '[x](https://a.test/"onmouseover="alert(1))',
    "`<img src=x onerror=alert(1)>`",
    "```html\n<script>alert(1)</script>\n```",
    "> <b onmouseover=alert(1)>quote</b>",
    '- <a href="javascript:alert(1)">x</a>',
    "||<img src=x onerror=alert(1)>||",
    "https://a.test/<script>alert(1)</script>",
    '<@01ARZ3NDEKTSV4RRFFQ69G5FAV"onclick="alert(1)>',
  ];
  it.each(payloads)("renders %j as inert text", (payload) => {
    const c = html(payload);
    // Nothing but the fixed set of elements; no event handler attributes; no script-capable URL.
    for (const el of Array.from(c.querySelectorAll("*"))) {
      expect([
        "DIV",
        "P",
        "SPAN",
        "STRONG",
        "EM",
        "DEL",
        "CODE",
        "PRE",
        "BLOCKQUOTE",
        "UL",
        "OL",
        "LI",
        "A",
        "BUTTON",
        "BR",
        "BDI",
      ]).toContain(el.tagName);
      for (const attr of Array.from(el.attributes)) expect(attr.name).not.toMatch(/^on/i);
    }
    for (const a of Array.from(c.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").toMatch(/^(https?:|mailto:)/i);
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    expect(c.querySelector("script,img,svg,iframe")).toBeNull();
  });
});

describe("rendering", () => {
  it("shows names for mentions, with deleted users and roles handled", () => {
    const c = html(`<@${USER}> and <@01ARZ3NDEKTSV4RRFFQ69G5FAY> and <@&${ROLE}>`);
    expect(c.textContent).toBe("@Ann and @Deleted User and @Mods");
  });

  it("makes channel mentions buttons", () => {
    const openChannel = vi.fn();
    html(`go to <#${CHAN}>`, ctx({ openChannel }));
    fireEvent.click(screen.getByRole("button", { name: "#general" }));
    expect(openChannel).toHaveBeenCalledWith(CHAN);
  });

  it("hides spoilers until activated", () => {
    html("||secret||");
    const sp = screen.getByRole("button");
    expect(sp.className).toContain("text-transparent");
    fireEvent.click(sp);
    expect(screen.queryByRole("button")).toHaveTextContent("secret");
    expect(screen.getByText("secret").className).not.toContain("text-transparent");
  });

  it("preserves line breaks and renders lists, quotes and code blocks", () => {
    const c = html("line one\nline two\n\n- a\n- b\n\n> q\n\n```\ncode\n```");
    expect(c.querySelector("p")!.className).toContain("whitespace-pre-wrap");
    expect(c.querySelectorAll("li")).toHaveLength(2);
    expect(c.querySelector("blockquote")).not.toBeNull();
    expect(c.querySelector("pre code")!.textContent).toBe("code");
  });
});
