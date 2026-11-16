// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { escapeHtml, renderShell } from "./shell.js";

// The real shell, so a change to its preview tags that the renderer no longer strips shows up here.
const shell = readFileSync(new URL("../../../web/index.html", import.meta.url), "utf8");
const meta = { title: "Join Friends on Tin Can", description: "You have been invited.", path: "/invite/abc" };

describe("renderShell", () => {
  it("replaces the static preview tags with one absolute set", () => {
    const html = renderShell(shell, meta, "https://chat.example.com/", "Tin Can");
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html.match(/name="twitter:card"/g)).toHaveLength(1);
    expect(html).toContain('<meta property="og:title" content="Join Friends on Tin Can" />');
    expect(html).toContain('<meta property="og:url" content="https://chat.example.com/invite/abc" />');
    expect(html).toContain(
      '<meta property="og:image" content="https://chat.example.com/brand/og-image.png" />',
    );
    expect(html).toContain("<title>Join Friends on Tin Can</title>");
    expect(html).not.toContain("Link previews");
    // The rest of the shell is untouched.
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it("escapes names chosen by people", () => {
    const evil = `"><script>alert('x')</script>&`;
    const html = renderShell(
      shell,
      { ...meta, title: evil, description: evil },
      "https://a.example",
      "Tin Can",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;");
    expect(escapeHtml("$&$'")).toBe("$&amp;$&#39;");
  });

  it("adds a title when the shell has none", () => {
    const html = renderShell("<html><head></head><body></body></html>", meta, "https://a.example", "Tin Can");
    expect(html).toContain("<title>Join Friends on Tin Can</title>");
    expect(html.indexOf("og:title")).toBeLessThan(html.indexOf("</head>"));
  });
});
