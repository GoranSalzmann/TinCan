# Security review: media and link previews

Scope: the branch that adds audio/video serving with `Range`, text excerpts, animated-image flags and the `link-previews` module ([23](../23-media-previews.md)). Method: read of the new code against 15 §4.3 and S-04…S-07, plus the tests named below. **Status:** ✅ verified here · ⚠️ verified with a stated limit.

## 1. Link previews: server-side fetching (SSRF)

| Risk | Control | Status / evidence |
|---|---|---|
| Fetching loopback, private, link-local, CGNAT, metadata addresses | Every address of every hop is checked by `isPublicAddress` (IPv4 deny list; IPv6 allow-list of global unicast; v4-mapped, NAT64 and 6to4 judged by the IPv4 inside) | ✅ `link-previews.test.ts` "isPublicAddress", "refuses private, loopback, metadata and odd-form addresses" (127/8, 10/8, 172.16/12, 192.168/16, 169.254.169.254, 100.64/10, `::1`, `::ffff:127.0.0.1`, `fd00::`, `2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`) |
| DNS rebinding / TOCTOU | The name is resolved once per hop by us and the connection goes to that address; `Host` and TLS `servername` carry the name | ✅ "resolves once and connects to the checked address"; a host with any bad answer is refused ("also resolves inside among public answers") |
| Redirect to an internal address or other scheme | Redirects followed by hand, at most 3, each hop fully re-checked | ✅ "checks every redirect hop again" (private IPv4, metadata, `[::1]`, `file:`, loop) |
| Other schemes, credentials, ports | Only `http(s)`, no `user:pw@`, ports 80/443 only | ✅ "refuses other schemes, credentials …, and ports" |
| Slow or endless responses | One timer per exchange (5 s per request, 8 s per preview) | ✅ "gives up on a server that dribbles or never answers" |
| Huge bodies, decompression bombs | 256 KiB of HTML (the rest is dropped), 64 KiB JSON, 2 MiB image (refused when larger); `Accept-Encoding: identity`; image pixel limit 24 M | ✅ "keeps only the start of a long page …" |
| Wrong content type | Allow-lists per request kind, checked before reading | ✅ "refuses the wrong content type and error statuses" |
| Leaking credentials or identity | No cookies, `Authorization` or `Referer`; fixed `User-Agent: TinCanLinkPreview/<version> (+source URL)` | ✅ "sends only an honest, minimal request" |
| Abuse as a request cannon | 20 fetches per person and 120 per server per minute (cache hits free); one in-flight fetch per URL; only URLs *inside a message the caller can see* are fetched | ✅ "limits fetches per person", "does not show a message's links to someone who cannot see its channel" |
| Provider endpoints chosen by a message | oEmbed endpoint hosts are constants (`providers.ts`); discovery links from a page are fetched through the same checks | ✅ `providerFor` tests (lookalike hosts refused) |

**IPv6 zone IDs and bracketed literals** are handled; **IPv6 addresses with an IPv4 tail** are parsed by hand (`ipv6Bytes`).

## 2. Link previews: content and privacy

- Everything from a third party is text: tags stripped, entities decoded once, control, bidi and zero-width characters removed, length-capped; no provider HTML is rendered (X's embed HTML is reduced to its text). The client renders these as React text nodes. ✅ `parse` tests, `LinkPreviews.test.tsx` ("shows provider text as text").
- Images: fetched by the server, re-encoded to WebP ≤ 640 px (metadata dropped), stored under a content hash, served same-origin to signed-in members with `CSP: sandbox`. **No member's browser contacts the third party; the Caddy CSP is unchanged** (`img-src 'self' data: blob:`). ✅
- The third party learns: this server's IP address and that the link was posted. It does **not** learn who posted or who read it. State this to the owner when they switch the feature on (the settings hint says it).
- Off by default; the setting lives in the database; an allow/deny list applies to the link and to where it ended up; a message's author or a moderator can remove its previews; the owner's setting changes and moderator removals are audited. ✅
- E2EE: only text messages carry links, and the server reads text messages by design. Voice (E2EE by default) has no text body. If text E2EE is ever built, previews must not run for those channels. ⚠️ nothing to test yet.
- Not in notifications, not in the search index (both are built from message text only; `link-previews.test.ts` "is not part of the search text"). ✅
- **Residual risks:** (a) a hostile site can serve a misleading title (it is shown as text with the site's name beside it, and the link opens with `noopener noreferrer nofollow`); (b) an attacker with a public site can make the server fetch that site once per message, within the rate limits; (c) a very large image that decodes to many pixels is bounded by the 2 MiB download and the pixel limit, but `sharp` runs on the event loop's thread pool; (d) the cache is shared, so a card made from one member's view is shown to all who can see a message with that link (no member data is in it).

## 3. Uploads: media, ranges, text

| Risk | Control | Status / evidence |
|---|---|---|
| A file labelled `video/*` or `audio/*` being shown inline although it is something else (HTML, script) | The container header is sniffed; a media label on other bytes is stored as `application/octet-stream` and served as a download | ✅ `media.test.ts` "does not trust a media label on other bytes" |
| Active content from the files endpoint | Unchanged: `nosniff`, `CSP: default-src 'none'; sandbox`, authenticated; only sniffed image and media types are `inline` | ✅ `uploads.test.ts`, `security.test.ts` |
| Range abuse | One range only; invalid, other-unit and multi-range headers get the whole file; out of range gets 416; no allocation depends on the range | ✅ `parseRange` tests, "serves it inline with range support" |
| Text excerpt shown as markup | Stored as a plain string, rendered as a text node in `<pre>`; HTML/XML show as source; control and bidi characters removed | ✅ `AttachmentView.test.tsx` "shows the start of a text file as escaped text, never as markup" |
| Excerpt cost / parsing hostile bytes | Only a 4 KiB range is read; strict UTF-8 / BOM'd UTF-16 decode; NUL or invalid bytes mean "binary", no preview | ✅ `makeExcerpt` tests |
| Information in excerpts of removed files | A removed file's wire form drops the excerpt | ✅ `wire()` in `uploads/service.ts` |
| Caching on devices | The service worker caches only `/assets/` and `/icons/`; files and previews are never cached | ✅ `pwa.test.ts` |

## 4. Not verified

- Caddy's behaviour for `Range` / 206 in front of the app (it forwards them; `encode` does not compress video or audio types). Needs the real host (**VPS**).
- Behaviour against real YouTube, Vimeo, X and Bluesky endpoints, including consent walls and rate limits.
- A hostile web server with a very slow TLS handshake (the single timer covers it, but only plain HTTP was exercised).
- `pnpm audit` / dependency changes: none added.

## 5. Found while testing (fixed on this branch)

- A UTF-16 text file starts with the bytes `FF FE`, which the first version of the MPEG sniffer took for an audio frame. Layer I headers are no longer accepted and the header fields are validated (`media.test.ts`).
- Two links carrying the same picture wrote the same storage key at once and one failed on the shared temporary file name. Writes of one key are now coalesced (`link-previews.test.ts`).
- Existing, unrelated: the audit-log `action` filter escapes `_` with a backslash but gives SQLite no `ESCAPE` clause, so a filter containing `_` never matches. Action names added here avoid underscores; the filter is worth fixing separately.
