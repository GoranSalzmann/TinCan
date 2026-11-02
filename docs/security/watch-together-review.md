# Security and privacy review: Watch Together (design stage)

> **Status: design review, 2026-11-02.** Nothing is built, so every "control" below is a requirement the build must meet and a test it must pass; the statuses in §8 are **⛔ not built**. Companion: [ADR 19](../19-watch-together-adr.md), [design 20](../20-watch-together-design.md). Style follows [m5-review.md](m5-review.md) and the threat-model delta required for new modules by 15 §9. Facts about outside services are marked *verified* or *unverified* as in 19. Not legal advice.

## 1. New surface

| Surface | What is new | Reachable by |
|---|---|---|
| Gateway ops | `watch.*` and `clock.ping` commands, `WATCH_*` events | Authenticated members with `VIEW_CHANNEL` |
| REST | `/watch/*`, `/admin/watch` | Members, moderators, owner |
| Outbound fetch (server) | oEmbed requests to fixed provider hosts | The server, triggered by a member's add |
| Client-side third-party content | YouTube IFrame API script and frame (opt-in); direct media from allow-listed hosts | A member's browser |
| Stored text | Item titles, authors, URLs, removal reasons, blocklist patterns | Members (write), everyone who can view (read) |
| Files | Own uploads served as video (Range requests) | Members with `ADD_WATCH_FILES` |
| Caddy headers | CSP entries per enabled provider | Every page load once a provider is on |

Assets at stake (15 §1): members' IP addresses and viewing habits, session and gateway ticket, the Host's server (via SSRF), the Host's legal position, availability of the sync room.

## 2. Actors

Malicious member (adds hostile links, floods commands, tries to control a room they should not); compromised member; Host (trusted, but must be told what the providers see); provider (YouTube and others: sees the viewer, serves script into our page); network attacker (TLS assumed); remote content owner or rights holder (takedown claims).

## 3. Threat analysis (STRIDE-oriented, in the style of 15 §4)

### 3.1 Server-side request forgery (SSRF)
| Threat | Control (requirement) |
|---|---|
| Member submits a URL that makes the server call an internal address (metadata service, LiveKit admin on 7880, loopback, RFC 1918) | **The server never requests a member-supplied URL.** For YouTube and Vimeo it extracts a strictly validated ID and builds the request to a hardcoded host itself (OWASP "build the request yourself", verified). For `html5` and `upload` items there is no server request at all |
| PeerTube instance host is user-influenced | Only hosts in `modules.watch.providers.peertube.instances` (Host config, not member input); requests still go through `packages/safe-fetch` (below) |
| Bug in ID extraction lets a host slip through | The ID regex is anchored and length-bound; the request URL is assembled from constants plus the ID; a unit test feeds 40 adversarial strings (userinfo `@`, backslashes, unicode dots, percent-encoding, newlines, `youtube.com.evil.example`) and asserts that the final request host is always the fixed one or the add is rejected. OWASP's rule "treat parser disagreement as a rejection" applies |
| DNS rebinding or redirect to an internal address on a fixed host | `safe-fetch`: resolve once, validate every address against the deny set (OWASP minimum ranges plus IPv4-mapped IPv6, `0.0.0.0/8`, link-local, carrier-grade NAT `100.64.0.0/10`, multicast, the LiveKit port), connect to the validated address while keeping Host and SNI, **no redirects followed**, apply the policy to retries, 3 s timeout, 64 KiB cap, no cookies, no proxy env vars, fixed `User-Agent` |
| Response body abuse (huge, slow, compressed bomb) | Hard byte cap while streaming; `Accept-Encoding: identity`; abort on cap or timeout |
| Fetch as an amplifier or scanner | Instance-wide 10 fetches per minute, per-member 5 per 10 s; results cached; failures counted, not retried in a loop |
| Fetcher reused by `link-previews` later | The same package and the same test suite; `link-previews` has more exposure (arbitrary URLs) and must pass the suite before it ships (15 §4.3 already requires it) |

The OWASP page supports the allow-list-and-build approach and the IP-validation requirements (verified). The *deny-list* ranges there are a minimum, not the primary defence here: the primary defence is that member input is never a host.

### 3.2 XSS and injection through titles, URLs and ids
| Threat | Control |
|---|---|
| Script in a title or author (oEmbed is third-party text) | Rendered only as React text nodes, never as HTML; stored with ≤ 200 characters, control characters and bidi overrides stripped; the Markdown renderer is **not** used for titles (S-06) |
| `javascript:`, `data:`, `blob:` or odd-scheme URLs in an item | The add endpoint accepts `https` only and canonicalises: YouTube items keep only the ID; `html5` items must pass the host allow-list and have a video extension; the original string is never used as a link `href` or `src` |
| Player iframe `src` injection | The iframe `src` is built in the client from `(provider, provider_ref)` with constants for the host and path and an ID that already passed the ID regex; the adapter refuses a ref that does not match |
| Lookalike hosts and IDN in the *displayed* URL | Show the canonical provider name and ID, not the member's text; for `html5` items show the real host (as the message renderer already does for links, 12 M2 note) |
| SQL | Kysely typed queries only (15 §4.2); `sort_key` generated server-side |
| Stored removal reasons and blocklist patterns | Same text rules; patterns are matched as exact strings or host suffixes, never evaluated as regular expressions (no ReDoS) |
| Mass assignment | zod `.strict()` on every body (15 §4.2); the channel `settings` JSON is validated by the module schema |

### 3.3 Content Security Policy and third-party code
| Threat | Control |
|---|---|
| **Google's IFrame API script runs inside our origin** (verified that the API is a script loaded into the page; the HttpOnly cookie cannot be read by it, but it can issue same-origin requests including the CSRF header, read the DOM, and see the gateway ticket exchange) | This is the single largest new trust expansion. Mitigations: opt-in at three levels (Host, channel, member); the script is loaded **only after** the member accepts the notice and presses Join, never at page load, so a member who never uses YouTube never runs it; CSP allows only the hosts it needs; no other third-party script; the client never keeps long-lived secrets in JS (11 §1.2 already: cookie + one-shot ticket); the Host is told in the admin guide in one sentence. **Isolating it in a sandboxed frame of our own is the better design but is reported as forbidden (nested iframe lineage, III.I.21, unverified summary): spike S7 reads the text and, if it allows a top-level sandboxed frame, this review changes to require it** |
| CSP widened site-wide for one feature | Entries are generated **per enabled provider** and only the minimum directives (`frame-src`, `script-src` host for the loader, `media-src` hosts); default CSP stays byte-identical when the module or provider is off (`templates.test.ts` pins both); `tincan doctor` compares the live header with the config and warns on `media-src https:` (`anyHttpsHost`) |
| `script-src` hosts the loader pulls in (for example `s.ytimg.com`) are not documented in what we read | Spike S3/S4 records them from a real load; the plan treats the list as **unverified until measured**; the CSP test uses the measured list |
| Inline event handlers or `unsafe-inline` creeping in | No change to `script-src 'self'` apart from provider hosts; no `'unsafe-inline'`, no `'unsafe-eval'` (the CSP check script `check:headers` must keep passing) |
| Clickjacking of our page | `frame-ancestors 'none'` unchanged; the player frame is a child, never a parent |
| Referrer leakage vs YouTube's Referer rule | `Referrer-Policy: no-referrer` stays site-wide. Only the YouTube iframe gets `referrerpolicy="strict-origin-when-cross-origin"`; this sends our origin (no path) to Google, which the API terms require (verified: `Referer` must identify the client). Not honouring it gives error 153 (verified). Spike S3 confirms the API respects an iframe we create ourselves |
| Permissions-Policy | `autoplay` and `fullscreen` default to `self` (verified); the provider iframe gets them through `allow="autoplay; fullscreen"` only, no camera or microphone |

### 3.4 Third-party requests and privacy
| Threat | Control |
|---|---|
| IP and header leak to a provider when a member merely opens the channel | None until the member presses **Join** after accepting the notice (R-W-021, R-W-031). Opening the channel loads no provider script, frame or image |
| Thumbnail requests to provider image hosts | Thumbnails are **off in v1**; only text and an icon (design 20 §8) |
| Cookies and tracking by the embed | Privacy-enhanced host `youtube-nocookie.com` (verified to stop views from influencing personalisation; **unverified** whether cookies or Google contacts occur before play, so S4 captures requests and cookies before and after play and the notice states only what is measured) |
| Autoplay data collection on page load | `autoplay=0` in the player parameters (the documented warning is that autoplay shares data on load, verified); playback only after a click |
| "Made for Kids" and consent rules | Policy requires checking and honouring tracking limits for such videos (III.E.4, unverified summary); because the embed is opt-in and the Host is the data controller (15 §6), the admin guide says so; a legal read is a memo item (D5) |
| Viewing habits visible to the Host and members | Stated in the UI (design 20 §11); the module logs no titles or URLs at info level |
| Presence disclosure | Viewers know the viewer list is visible to everyone who can see the channel |
| Telemetry | `watch.stats` is off by default and aggregate-only; no client reports to any third party |

### 3.5 Permission and access control
| Threat | Control |
|---|---|
| Gateway op used without VIEW_CHANNEL or after losing it | Every `watch.*` command checks `VIEW_CHANNEL` and the specific bit through `RolesApi` at execution time (not at join); a channel the caller cannot view answers `404` like other channels (07 M2 note) |
| Control without `CONTROL_PLAYBACK`, or against `controlMode` | Server rule, covered by tests; the client UI is cosmetic |
| IDOR on item ids | Item lookups are scoped by `(channel_id, item_id)`; an item id from another channel is `NOT_FOUND` |
| Stale commands against the wrong item | Every command carries `itemId`; mismatch answers `STALE_ITEM` (prevents the "pause lands on the next video" bug and a replay across items) |
| Privilege through the new bits | `CHANNEL_SCOPED` becomes an explicit set; test pins it; `authz.matrix.test.ts` rows for every watch route × role × channel situation (S-04) |
| Viewer keeps receiving events after ban, kick, role loss | `watch` subscribes to the same events as voice and also runs a **reconciler** every 30 s that re-checks every viewer's `VIEW_CHANNEL` and removes them (same level-triggered pattern as S-16, 04 §6); event delivery is also filtered by the channel-access hook (`dispatchToChannel`) |
| Timed-out member keeps adding | `TIMEOUT_REMOVES` includes the add and control bits |

### 3.6 Abuse, griefing and denial of service
| Threat | Control |
|---|---|
| Pause or seek spam | Rate limit 10 commands per 5 s per member per channel; server serialises; `controlMode` lets a channel restrict to managers; audit shows the actor in the event `updatedBy` |
| Holding the room hostage via buffering | Wait cap 8 s, 2 waits per viewer per item, detach afterwards (design 20 §6.6) |
| Queue flood | 20 queued per member, 200 per channel, add rate limits, lock switch |
| `clock.ping` flood | 10 per 10 s per socket; the handler is O(1) |
| Many rooms | `viewersMax` and a soft node limit; metrics; memory per room is a few KB |
| Fake `watch.ended`, `watch.duration` | Majority rule for `ended`; `duration` needs agreement of two viewers or metadata; a single viewer cannot skip the item for a room of two or more |
| Harassing content (shock video) | Instant removal by managers, blocklist by ID/host, channel lock, timeouts; item adder is in the audit log. The video appears only to joined viewers (opt-in), not on opening the channel |
| Huge or malicious uploaded media as watch items | Existing upload limits and quota (R-021); files stay `Content-Security-Policy: sandbox` + `nosniff`; only types in a short video allow-list (mp4, webm) become watch items; the browser decodes them in its own sandbox (codec parser exposure is the browser's, as for images in S-07) |

### 3.7 Uploads as watch items (only when enabled)
| Threat | Control |
|---|---|
| Range requests are needed for seeking; the file route is chunked without `Content-Length` today (07 M2 note) | Task: add `Range`/`206` and `Accept-Ranges` to `GET /files/:id/:filename` with the same auth and the same `sandbox`/`nosniff` headers, with tests for malformed and overlapping ranges (S6) |
| Orphan GC deletes an attachment that is queued | `UploadsApi` gets a claim/release call; the watch item holds the claim; deleting the item releases it; quota semantics unchanged |
| Copyright exposure of hosted content | See §6; default off; `ADD_WATCH_FILES` not in `@everyone` |
| Hotlinking the file endpoint | Same authentication as other files (cookie, member only) |

## 4. Data retention and the 30-day rule
YouTube-derived titles and authors are stored with `meta_fetched_at` and nulled after 29 days (design 20 §7), because the policy reportedly limits storing non-authorised API data to 30 days (III.E.4; **unverified**, summary of an unread part of the page; spike S7 reads the text). Item ids are kept; they are the member's own queue entries. Backups contain whatever is in the table at backup time; the admin guide notes this.

## 5. Consent for programmatic control (policy and ethics)
The YouTube policies say users must be aware of and have actively consented to actions an API client takes on their behalf (verified), and that an action on a YouTube resource must be clearly initiated by the user (verified, III.C.2). Another member's click causing my player to play, pause or seek is not addressed by a specific rule we found. The design gets the strongest defensible footing without the rule being clear: a member must **explicitly join** after reading the notice; joining states that the room controls playback; leaving is one click; the first-use notice says "other members can start, pause and move this video for you while you are watching". Whether Google considers this compliant is **unknown**; the plan offers to request Google's API compliance audit (the policy guide offers it for doubtful cases, verified) before announcing YouTube support, and keeps YouTube behind its own flag.

## 6. Abuse and copyright exposure for a self-hosting Host
Not legal advice; facts are secondary summaries (19 §2).

| Mode | Exposure (summary) |
|---|---|
| Link or embed of a provider's video (YouTube, PeerTube, Vimeo) | The content stays on the provider. EU case law as summarised says linking can matter if the linker knows content is unauthorised, and embedding a freely available video was held not infringing in one case; US courts split on the "server test". The practical risk is lower than hosting, and takedowns go to the provider |
| Direct URL on an allow-listed host | Same as a link, but the Host chose the host list |
| **Member upload served by the Host** | The Host stores and serves the file: this is the high-exposure mode (notice-and-takedown duties, possibly hosting-provider rules; unverified which regimes apply to a private invite-only server) |
| Screenshare | The Host's server relays encrypted media and does not see it; the sharer is the actor |

Controls: default off; invite-only default stays; uploads off by default and out of `@everyone`; audit of who added what; removal, blocklist and a documented takedown procedure in the admin guide (find by ID or hash, remove the item and the file, record in the audit log, keep the note); the ToS text (YouTube's: personal, non-commercial; no public screening, verified) is in the notice. A one-page "if you get a takedown request" guide is a deliverable of milestone W4.

## 7. E2EE interaction
Voice E2EE stays on and unaffected. What a watch channel can and cannot promise:
- **Can:** nothing about the video travels through LiveKit unless someone screenshares; with screenshare the existing E2EE applies.
- **Cannot:** hide queue, titles, positions or who watches from the Host and from members; hide viewing from the provider; prevent a member from recording their screen (15 §10).
- The UI must not show a lock or "encrypted" label in a watch channel (K-11 spirit: no overclaiming).

## 8. Requirements (testable) and status

| ID | Requirement | Planned evidence | Status |
|---|---|---|---|
| SW-01 | No server request ever targets a member-supplied host; oEmbed requests are built from a validated ID to a fixed host | Adversarial-input unit test on the ID extractor and the request builder; `safe-fetch` suite (private, loopback, link-local, mapped IPv6, rebinding, redirect, oversize, slow body) | ⛔ not built |
| SW-02 | Titles, authors, URLs and reasons render only as inert text; no HTML path | 17-payload battery like `markdown.test.tsx` applied to the queue; stored-text sanitiser test | ⛔ |
| SW-03 | Default CSP and Referrer-Policy are unchanged when the module and providers are off; provider entries appear only when enabled | `templates.test.ts` golden files for off, YouTube on, allow-list, `anyHttpsHost` | ⛔ |
| SW-04 | Opening a watch channel makes no request to a provider host | Playwright test with network interception: zero requests to provider hosts before Join, and before notice acceptance | ⛔ |
| SW-05 | Every `watch.*` op and route enforces permission and visibility; losing access removes the viewer within one reconciliation interval | `authz.matrix.test.ts` rows; reconciler test with a failed first removal (as S-16) | ⛔ |
| SW-06 | `CHANNEL_SCOPED` covers bits 0 to 14 and 27 to 30; overwrites on new bits work and others stay rejected | `permissions.test.ts` | ⛔ |
| SW-07 | Rate limits and caps in design 20 §12 hold; the group wait cannot exceed 8 s or be triggered more than twice per viewer per item | Unit tests with the simulator; gateway tests | ⛔ |
| SW-08 | One viewer cannot skip or end an item for two or more viewers | Gateway test | ⛔ |
| SW-09 | The Range endpoint is safe: malformed, multiple and overlapping ranges, suffix ranges, auth, headers | `uploads.test.ts` additions | ⛔ |
| SW-10 | Logs contain no item URLs or titles at info level | Extend the log-redaction test in `security.test.ts` | ⛔ |
| SW-11 | `tincan doctor` flags `anyHttpsHost`, a missing provider CSP entry, and a Referrer-Policy that blocks the YouTube Referer | `doctor.test.ts` | ⛔ |
| SW-12 | Disabled module leaves no routes, no gateway ops, no capability | module matrix + `security.test.ts` route list | ⛔ |

All twelve are design-time requirements; none is verified because nothing is built.

## 9. Residual risks and accepted gaps (for the owner)

| # | Risk | Rating | Note |
|---|---|---|---|
| WR-1 | Google script in our origin when YouTube is on | M likelihood × H impact | Opt-in, late loading, minimal CSP; remove the risk by not enabling YouTube, or by an isolating design if S7 allows |
| WR-2 | Provider terms change or are enforced against sync use | M × M | Feature flag per provider; HTML5 adapter independent |
| WR-3 | Ads and region locks desync viewers in a way no code fixes | H × L | Documented; best effort label |
| WR-4 | Takedown or copyright claim, mainly via uploads | L × H | Uploads off by default; procedure; audit |
| WR-5 | A member records the screen or the audio | H × L | Inherent (15 §10) |
| WR-6 | The group wait can be annoying even within caps | M × L | Per-channel switch; caps |
| WR-7 | `s.ytimg.com`-style extra script hosts or cookies appear that the notice does not mention | M × M | S4 measures; notice text is written from the measurement |

## 10. Process
Per 15 §9 this review is the threat-model delta for the module; it is re-run against the code at the end of W4 (a column "evidence" replaces "planned evidence") and a CodeQL pass on the new module is part of every pull request as for other modules. An external review is more valuable for `safe-fetch` than for the rest; the owner decides whether to commission one (memo D8).

## Open items
- S7 outcomes (nested iframe, storage rule, consent) can change §3.3 and §4.
- Measured script host list and cookie list (S3, S4).
