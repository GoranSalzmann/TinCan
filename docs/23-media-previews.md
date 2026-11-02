# 23. Media and link previews

> Status: built on branch `feat/media-previews` (not released). Extends 07 §3.7 (uploads), 12 (client) and 15 §4.3 (content, previews).
> Open owner questions are collected at the end and in 18 §S.

Six improvements to how attachments and links look in chat. Each says what was chosen and why; the security review is [security/media-previews-review.md](security/media-previews-review.md) and the manual checks are [qa/media-previews.md](qa/media-previews.md).

## 1. What stays the same

- Files are served by `GET /api/v1/files/:id/:filename`, authenticated, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`. Nothing is served from a third-party origin.
- The Caddy CSP is **not loosened**: `img-src 'self' data: blob:`, `media-src 'self' blob:`. Link-preview images are re-hosted by the server (§7), so members' browsers never contact a third party.
- The service worker caches only `/assets/` and `/icons/`; files, previews and the API are never cached on the device (`pwa.test.ts` already pins this).
- No new native dependency. `sharp` (already used) does all image work. No `ffmpeg`.

## 2. Uploaded content types (server)

The first 16 bytes already decide whether a file is a raster image. They now also decide whether it is **audio or video**:

| Magic bytes | Stored type |
|---|---|
| `ftyp` at 4, brand `qt  ` | `video/quicktime` |
| `ftyp` at 4, brand `M4A `/`M4B ` | `audio/mp4` |
| `ftyp` at 4, other brand | `video/mp4` |
| `1A 45 DF A3` (EBML) | `video/webm` (`audio/webm` when the file name ends `.weba`) |
| `OggS` | `audio/ogg` |
| `ID3` or an MPEG frame sync | `audio/mpeg` |
| `RIFF…WAVE` | `audio/wav` |
| `fLaC` | `audio/flac` |

*Why:* the declared type is only a hint (07 §3.7). Before this change a file declared `video/mp4` was stored as declared and always served as a download; trusting the label to decide "show inline" would let any file be presented as media. A declared `audio/*` or `video/*` type that does not match the bytes is stored as `application/octet-stream`. Only the sniffed types above are served `inline`.

Animated images: `sharp` reports more than one page for animated GIF and WebP; PNG is checked for an `acTL` chunk (APNG). The result is stored as `animated` on the attachment. AVIF is not accepted as an inline image today and is left out.

## 3. Item 1: GIFs and animated images animate in place

- A static image keeps the existing thumbnail (WebP, 512 px).
- An **animated** GIF/WebP/APNG is shown as its original file (so it animates) when it is at most `ANIMATION_AUTOPLAY_MAX_BYTES` (8 MiB) **and** the system does not ask for reduced motion. Otherwise the still thumbnail is shown with a "Play" button; pressing it swaps in the original. Reduced motion never auto-swaps, whatever the size.
- `loading="lazy"` stays; the box size is reserved from `width`/`height`.
- Choice: the threshold is a constant in `apps/web/src/modules/chat/media.ts`, not a server setting. A member's data plan is the reason for it, and it needs no owner decision.

## 4. Item 2: videos

- `<video controls preload="metadata" playsinline>` with no autoplay. The browser's own controls give keyboard and screen-reader behaviour (the element has an `aria-label` with the file name).
- **Poster:** none is generated on the server. `ffmpeg` would be a heavy native dependency (not added without asking), and `sharp` cannot read video. Instead `#t=0.1` on the source makes browsers show the first frame from the metadata request. Chosen over a server poster because it costs no CPU on the server, no stored object and no new attack surface; the price is that a few mobile browsers show a black box until play.
- **Codec fallback:** a `<video>` `error` event (the browser cannot play the codec, for example HEVC `.mov` on Firefox) replaces the player with the file card and a download link. The link is always present below the player.
- **Max inline size:** `VIDEO_INLINE_MAX_BYTES` = 1 GiB. Bigger videos are file cards (download only). `preload="metadata"` fetches only the headers, so a large file costs nothing until played.
- **Range requests:** `GET /files/:id/:name` now answers `Accept-Ranges: bytes` and honours one `Range` (206 with `Content-Range`, 416 with `Content-Range: bytes */size` when out of range). Multi-range requests get the whole file (allowed by RFC 9110). Seeking and Safari (which refuses to play video without ranges) depend on this. Caddy forwards `Range` and 206 unchanged and does not compress video/audio types; see the unverified list in the review.

## 5. Item 3: audio

- `<audio controls preload="metadata">` in a card (icon, file name, size, duration once known) using the design tokens; `color-scheme` follows the theme so the native control is dark in dark mode.
- **One at a time:** a module-level registry pauses the previously playing audio or video when another starts (`play` event).
- Voice-message-like files (`.ogg`, `.webm`, `.m4a` recorded by phones) are the same component. Duration comes from `loadedmetadata`; waveforms are out of scope.

## 6. Item 4: file-type icons

One function, `fileKind(contentType, filename)` in `apps/web/src/modules/chat/fileKind.ts`, returns a kind (`image`, `video`, `audio`, `pdf`, `document`, `spreadsheet`, `presentation`, `archive`, `code`, `text`, `model`, `font`, `other`) and the file card shows a lucide icon **plus a visible type word** ("PDF", "Archive", …) so meaning never rests on the icon or a colour. Content type wins; the extension is the fallback because uploads are often `application/octet-stream`. Tests cover the table.

## 7. Item 5: small text preview

- **Where the excerpt is made: on the server, at upload time**, stored in two new columns (`excerpt`, `excerpt_truncated`) and sent with the message. *Why not range-read in the browser:* it would add a request per file per viewer, run the charset detection in the client against hostile bytes, and show nothing if the user cannot download while offline. *Cost:* up to 600 characters per text attachment in the message JSON and in the database.
- Which files: by extension (txt, md, csv, tsv, json, log, xml, html, yaml, toml, ini, css, source code…) or a `text/*` / JSON declared type. HTML and XML are text here because the **bytes are never interpreted**: the excerpt is a string rendered by React as a text node inside `<pre>`, so it is escaped. The file itself is still stored as `application/octet-stream` and served as a download (07 §3.7).
- Only the first 4 KiB are read from storage (a range read). Decoding: UTF-8 BOM, UTF-16 LE/BE BOM, BOM-less UTF-16 when almost every second byte is NUL, otherwise strict UTF-8 (a cut-off last character is dropped). A file with NULs elsewhere, invalid UTF-8, or more than 10% control characters is **binary**: no excerpt.
- Limits (`apps/server/src/modules/uploads/excerpt.ts`): 8 lines or 600 characters, whichever is hit first. Control characters and bidi overrides (U+202A–202E, U+2066–2069, which can reorder text to mislead) are removed; CRLF becomes LF.
- Not in the search index and not in notification text: search indexes `searchText(message.content)` and notifications are built from the message text; the excerpt belongs to the attachment and neither reads it.
- "Open" is the existing download link; the card says whether the excerpt is cut short.

## 8. Item 6: link previews

### 8.1 Shape

A new module `link-preview` (manifest `link-preview`, depends on `roles`, `text-chat`) with a reusable service `fetchPreview(url)` that other modules could call (a Watch Together channel, 20). It owns three tables: `link_preview_cache`, `link_preview_suppressed`, `link_preview_setting`.

**The client asks, the server unfurls.** `GET /api/v1/link-previews/messages/:messageId` returns the previews for at most three distinct URLs in that message's text. The server loads the message itself, checks the caller can see the channel, and takes the URLs from the stored text. *Why not `GET /preview?url=`:* that would make the server an open fetcher for any member and could not carry a per-message removal. The cost is one request per message that has a link (cached, so after the first view it is a database read).

E2EE: only text messages carry URLs and the server reads text messages by design (10). Voice and its E2EE state have no message body, so nothing is ever fetched for them. If text E2EE is ever added, this module must not run for those channels (noted in 10 as a constraint).

### 8.2 Default: **off**

The owner turns it on in Server settings. Reasons: 15 §4.3 already says "off by default"; every enabled preview makes this server contact whatever site a member posts (revealing the server's IP and that the link was posted, and giving a link-poster a way to make the server fetch a URL of their choosing); and a self-hosted server for friends can ask once. The setting is stored in the database, takes effect at once and is shown in capabilities (`features.linkPreviews.enabled`).

### 8.3 Fetching safely (`safeFetch`)

- Only `http:` and `https:`, ports 80 and 443 only, no credentials in the URL, host name or IP literal. The WHATWG URL parser first normalises forms such as `2130706433` and `0x7f.1` to dotted decimal.
- DNS is resolved **by us**, every address is checked, and the connection is made **to the checked IP** (`servername`/`Host` carry the name, so TLS verifies the certificate against the host name). There is no second lookup, so DNS rebinding cannot swap the address.
- Blocked ranges: IPv4 `0/8, 10/8, 100.64/10, 127/8, 169.254/16 (cloud metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4`; IPv6 unspecified, loopback, `fc00::/7`, `fe80::/10`, `fec0::/10`, multicast, `2001:db8::/32`, Teredo, and v4-mapped / NAT64 / 6to4 addresses are unwrapped and checked as IPv4. Any one blocked address among a host's answers rejects the host.
- Redirects: followed by hand, at most 3, **each hop goes through the whole check again** (scheme, port, DNS, IP).
- No cookies, no `Authorization`, no `Referer`, `Accept-Encoding: identity` (no decompression bombs), fixed `User-Agent: TinCanLinkPreview/<version> (+<server source URL>)`; honest and recognisable in other people's logs.
- Time: 5 s per request, 8 s per preview in total. Size: at most 256 KiB of an HTML body (the rest is dropped; `<head>` is almost always inside), 64 KiB for oEmbed JSON, 2 MiB for an image. Content types are checked before reading (`text/html`, `application/xhtml+xml`; `application/json`; `image/png|jpeg|gif|webp`).
- Rate limits: 20 fetches per person per minute and 120 per server per minute (cache hits are free). Concurrent fetches of one URL share one request.

### 8.4 What is read and what is shown

- Sources in order: a known oEmbed provider (YouTube, Vimeo, SoundCloud, Spotify, Bluesky, X/Twitter, Reddit is not listed because it blocks anonymous clients), then Open Graph / Twitter-card meta tags, then `<title>`; as a last step an oEmbed `<link rel="alternate">` the page advertises (fetched through the same checks).
- Everything is **text**: title ≤ 150 and description ≤ 300 characters, tags stripped, entities decoded once, control and bidi characters removed. No provider HTML is ever rendered. For X, the oEmbed answer contains an HTML blockquote; only its plain text is extracted.
- **X/Twitter honestly:** `publish.twitter.com/oembed` currently answers without credentials for public posts and returns the author and the post text, but no image; X can change or throttle that at any time, and pages themselves carry no usable Open Graph tags without JavaScript. When it fails the message simply gets no card (the plain link stays). Not testable from this machine (§ unverified).
- **YouTube:** oEmbed gives title, channel and a thumbnail; the description comes from the watch page's `og:description` when that fetch succeeds (EU consent redirects may stop it; the card then shows without description).
- **Images:** the preview image is fetched by the server (same checks), checked and resized with `sharp` to at most 640×360-fit, stored as WebP under `lp/<hash>` and served from `GET /link-previews/image/:hash` (authenticated, same-origin). Members' browsers never contact the third party, and the CSP is unchanged.

### 8.5 Control

- **Owner:** `GET/PATCH /admin/link-previews` (owner only): `enabled`, `allowDomains` (when non-empty, only these and their subdomains), `denyDomains` (always wins). Shown in Server settings.
- **Per message:** the author or anyone with `MANAGE_MESSAGES` can remove previews (`DELETE …/messages/:id`); stored in `link_preview_suppressed`, honoured for everyone. A removal by someone other than the author writes an audit entry `message.link_preview_remove`. Writing `<https://…>` in a message (angle brackets) also suppresses a preview, as in other chat apps.
- Cache: positive 24 h, negative (no metadata, blocked, error) 1 h; a daily job removes expired rows and unreferenced images. The cache is keyed by URL, shared between members; a preview carries no member data.

## 9. Open questions for the owner

See 18 §S: the default for link previews, whether to allow YouTube/X lookups at all by default once enabled, the 8 MiB animation threshold, whether to generate video posters server-side with `ffmpeg` later (adds a native dependency in the Docker image).
