# 19. Watch Together: embed or build? (ADR-019)

> **Status: Proposed (planning only, 2026-11-02).** Nothing in this set is built. The owner decides; the decisions that are theirs alone are in [22](22-watch-together-owner-memo.md). Companion documents: feature design [20](20-watch-together-design.md), security and privacy review [security/watch-together-review.md](security/watch-together-review.md), milestone and test plan [21](21-watch-together-plan.md), demo checklist [qa/watch-together.md](qa/watch-together.md).
>
> **How facts are marked.** *Verified* means a page was read on **2026-11-02** (source in §9). *Unverified* means it comes from a search snippet, a summary of a page, a secondary source, or memory, and a spike in [21](21-watch-together-plan.md) must confirm it before the design relies on it. Where a fetch returned only a model-written summary of the unread part of a page, that is said. **This is not legal advice.**

## 1. Context

The owner wants a new channel type, a "Watch Together" channel: videos or playlists go on a watch list, and everyone in the channel sees the same content in sync (play, pause, seek, next item, who is watching).

Constraints that already exist (doc number in brackets):

- AGPL-3.0-or-later, self-hosted, **privacy first: no third-party requests from clients by default** (15 §6), strict CSP (15 §5, `apps/server/src/cli/templates.ts`).
- Modular monolith: a new feature is a module that owns its tables and never imports another module (03 ADR-003, 04). Channel types today are `text` and `voice`; `channels.type` is a plain text column, so a new type needs no table rebuild.
- Single SQLite node, WebSocket gateway for low-latency commands, REST for state changes (07 §1, ADR-007).
- Voice E2EE is on by default (10); text is not E2EE (ADR-011).
- Target scale 5 to 200 members, about 10 viewers per stream (01 §2). A watch room is a small group.
- Web client only (PWA, 12 §14); phones are in scope as responsive web.

The question to decide with evidence: which player(s) do we use, and who owns the sync logic.

## 2. What we found that shapes the decision

Each point is tagged **V** (verified) or **U** (unverified).

**Sync is the same problem whatever the player is.** Every project we read does the same three things: the server (or a leader) holds one authoritative position; clients correct their own player toward it; late joiners and buffering get special handling. The differences are in thresholds and in how well the player obeys.

| Project (licence) | Authoritative time | Correction | Source |
|---|---|---|---|
| SyncTube (MIT; V sidebar) | Server timer with no tick loop: `startTime`, `pauseStartTime`, `rate`; position computed on demand (`VideoTimer.hx`) | Clients poll every `synchThreshold` s (default 2); seek if the difference is at least the threshold, seeking `+0.5 s` for buffering; one **leader** controls play, pause, seek and rate; start waits for everyone's "loaded" or 3 s | V (fetched source) |
| Syncplay (Apache-2.0) | Server broadcasts a global position about every 1 s (`SERVER_STATE_INTERVAL = 1`); clients extrapolate from the age of the message | Slow down to 0.95× when more than 1.5 s ahead, back to 1.0× under 0.1 s; rewind when more than 4 s ahead; fast-forward when 5 s behind; seeks under 1 s are not treated as seeks; `SYNC_ON_PAUSE` | V (`constants.py`, part of `client.py`; the protocol file was not read) |
| Jellyfin SyncPlay (jellyfin-web GPL-2.0 text) | Server group state machine (Idle, Playing, Paused, Waiting); commands carry `When` (server time) and `PositionTicks` | NTP-style clock offset from 4 timestamps, the **minimum-delay** sample of the last 8, polling 1 s for 3 pings then every 60 s. Drift correction is **off by default** (`enableSyncCorrection=false`). When on: 60 ms to 3 s gap is fixed by a rate change (`1 + diff/duration`, 1 s long, minimum speed 0.2), 400 ms and over by a seek, re-evaluated at most every 1.5 s. A `Waiting` state pauses everyone until all are ready; unpause is scheduled in the future (`max(2 × highest ping, default ping)`) | V (`PlaybackCore.js`, `TimeSync.js`, `WaitingGroupState.cs`) |
| PeerTube (AGPL-3.0, U for the embed API package) | n/a (an embeddable player, not a sync tool) | Embed API: `play`, `pause`, `seek`, `getCurrentTime` (7.0 and newer), `setPlaybackRate`, `playbackStatusUpdate` every 0.5 s | V (docs.joinpeertube.org) |

Pitfalls seen in public reports: setting 1.5× under SyncPlay stalled playback and reset to 1.0× (Jellyfin issue 11302, U: a search snippet); HLS errors after repeated skips (forum thread, U). Our design treats rate changes as best-effort and re-checks after every nudge.

**Licences of the sync projects.** We cannot copy code from jellyfin-web: its `LICENSE` file is the GPL-2.0 text (V) and GPL-2.0-only is not compatible with AGPL-3.0; whether individual files say "or later" was not checked (U). SyncTube (MIT, Haxe) and Syncplay (Apache-2.0, Python) are compatible but written in other languages. **We reuse ideas and constants as starting points, not code.** SyncTube's hosted-service model (one channel, its own accounts and permissions) would also duplicate our auth, roles and audit.

**Embedding is regulated by provider terms, and YouTube's are strict (V unless marked).**

- YouTube required minimum functionality (RMF) and Developer Policies: no overlays, frames or visual elements in front of any part of the embedded player including its controls; no changes to the player beyond what the API documents; no modifying or blocking ads (U: policy III.I.5, summary of the unread part); no downloading, caching or storing audiovisual content; no separating audio or video; **no background play**; the player must be at least 200×200 px; at most one autoplaying player; autoplay only when more than half the player is visible; the page must send an HTTP `Referer` or the player shows **error 153**; the API client must display a link to YouTube's Terms, state that users agree to them in its own terms, and require users to accept a privacy policy that links to Google's (III.A.1, III.A.2).
- Non-authorised API data may not be stored more than 30 days without the owner's authorisation (III.E.4, U: summary, not verbatim). This matters for titles and thumbnails we cache.
- **Nested iframes**: "situate the YouTube player in a nested or hierarchical iframe lineage" is reported as prohibited (III.I.21, U: summary). It rules out isolating the player in our own sandboxed frame.
- **User consent**: "users must be aware of and have actively consented to the actions that an API Client takes on their behalf" (Principle 3, V). A program-driven play, pause or seek on a viewer's player, started by *another* member's click, is not addressed by a specific rule (not found). It is a grey area, see §6 and the owner memo.
- YouTube's own Terms: "You may also show YouTube videos through the embeddable YouTube player" (V), and viewing is for personal, non-commercial use, "you may not publicly screen videos" (V). A private friends group is not a public screening, but the Terms do not mention sync or watch parties (not found).
- Privacy-enhanced mode: swap the host to `youtube-nocookie.com`; Google says views in this mode do not personalise the viewer's YouTube experience and ads are non-personalised (V, support.google.com/youtube/answer/171780). **Whether it sets cookies or contacts Google before play is not documented there** (not found; the claim "no cookies until the user interacts" comes from a consent-vendor page, U). Spike S4 measures it.
- IFrame API: `seekTo` goes to the keyframe before the time unless that part is buffered; `setPlaybackRate` "does not guarantee that the playback rate will actually change" and rates are a discrete list; `onAutoplayBlocked`, `onPlaybackRateChange`, `onError` (101 and 150: embedding disabled by the owner, 100: not found or private, 153: no Referer) exist (V, partly from a summary). `origin` should be set when using the JS API (V). `getDuration` is 0 until metadata loads (V). There is **no `host` playerVar** in the pages we read (not found).
- **The API script runs in our origin.** `iframe_api` is a script loaded from a Google host into our page. It sees our DOM and can call our API as the user (the session cookie is HttpOnly, but the CSRF header is only a header). This is the largest trust expansion in the whole feature. It does not apply to the HTML5 player.
- Vimeo (Player SDK, MIT, V): `play`, `pause`, `setCurrentTime`, `setPlaybackRate` (**Pro and Business accounts only** for the video owner, V), `timeupdate` about every 250 ms (U), programmatic `play` impossible on iOS (V). Vimeo's terms and the `dnt` option could not be fetched (page rendered by script): unverified.
- Twitch (V): the `parent` parameter (a hostname, https only) is required, minimum 400×300 px, Twitch "reserves the right to revoke your ability to use our embeddable experiences, for any reason, at any time". `seek`, `getCurrentTime` and `getDuration` work **for VODs only**; there is no time-update event; live streams cannot be synced by time. No oEmbed found. Developer agreement not read.
- Dailymotion (V): Web SDK still documented; `seek`, `play`, `pause`, `setPlaybackSpeed`, `VIDEO_TIMECHANGE`; **no `getCurrentTime`/`setCurrentTime` in the method list**; oEmbed needs a Player ID we would have to create on their side.
- PeerTube (V): needs `?api=1`; instance hosts are arbitrary, so the CSP and the allow-list are per instance; it is AGPL software and self-hosted, so no provider-side ad or tracking rules apply to the instance we pick.

**Metadata without API keys (V).** YouTube oEmbed `https://www.youtube.com/oembed?url=…&format=json` answered 200 with title, author, thumbnail URL and sizes, and **no duration**. Vimeo oEmbed answered 200 and includes duration. YouTube playlist expansion has no keyless route that we verified (oEmbed of a playlist URL: unverified), so v1 playlists are our own queue, not an imported provider playlist.

**Browser platform (V, MDN, 2026-11-02).**

- Media with audio may autoplay only if muted, the user has interacted with the site, the site is allow-listed, or the Permissions Policy `autoplay` is delegated to an iframe (`allow="autoplay"`); a rejected `play()` raises `NotAllowedError`, there is no event for blocked autoplay, and `navigator.getAutoplayPolicy()` reports the state. Safari needs `playsinline`.
- `HTMLMediaElement.playbackRate` is widely available; pitch is corrected by default; audio is muted outside a useful range (Gecko: outside 0.25 to 4.0).
- `requestVideoFrameCallback` is Baseline since October 2024 (newly available).
- Background tabs: timers are throttled (budget based, after 10 s in Chrome, 30 s in Firefox, per MDN); a tab playing audio counts as foreground, WebSockets are not throttled.
- Media Session API is *limited availability* (not Baseline).
- Players: hls.js Apache-2.0 (summary text, U), dash.js BSD (V, clause count not given), Plyr MIT and vidstack MIT (V, both now **deprecated in favour of Video.js 10, security fixes only**), Video.js licence not read. We use none of them in v1: a bare `<video>` with our own small controller is enough, and avoids a dependency that is already on a maintenance path.
- SSRF (OWASP cheat sheet, V): allow-list the host and **build the request yourself**; do not accept full URLs; disable or re-validate redirects; validate the resolved IP and connect to that address while keeping Host and SNI; apply the policy to retries; reject parser disagreements; the deny-list ranges are the minimum, not the plan. This matches 15 §4.3 and is the basis of the security review.

**Law, briefly (secondary sources only, not advice).** EU: *GS Media* (C-160/15, 2016) says linking to freely available material can be a communication to the public if the linker knew, or is presumed to know when linking for profit (Wikipedia summary, U); *BestWater* (C-348/13) is summarised as holding that embedding a freely available video is not an infringement (secondary, U). US: the "server test" (Ninth Circuit, *Perfect 10 v. Amazon*) says a site that only embeds content hosted elsewhere generally does not directly display it, but district courts have departed from it and the page reports a circuit split (secondary, U; one cited 2026 decision was not checked). The judgments themselves could not be fetched. **Practical reading:** a link or embed exposes the host far less than hosting a file; a member upload makes the Host a hosting provider with takedown duties. The owner should ask counsel before enabling uploads on a public instance (memo D6).

## 3. Options considered

| ID | Option | In one line |
|---|---|---|
| A | **Adopt** an existing watch-together app (SyncTube) as a sidecar or fork | Fastest demo, separate accounts, language and permissions |
| B | **Embed only**: own sync engine, provider SDKs (YouTube, Vimeo, Twitch, Dailymotion, PeerTube) | Widest content, most third-party exposure |
| C | **Build, HTML5 only**: own sync engine, own `<video>` player for allow-listed direct URLs and member uploads | Best privacy and sync, no YouTube |
| D | **LiveKit screenshare only**: someone shares a tab with audio | Zero new code, no queue or per-viewer control |
| E | **Hybrid (recommended)**: own sync engine behind a `PlayerAdapter` interface; adapters for **HTML5** (own files, allow-listed hosts) and **YouTube** (opt-in per server, privacy-enhanced host); others later; screenshare stays the documented fallback | Matches the request, privacy-first by default, each provider isolated |

## 4. Scoring

Weights sum to 100. Scores 0 to 5 are judgements from the findings above; the arithmetic is shown so it can be argued with.

| Criterion | Weight | A | B | C | D | E |
|---|---|---|---|---|---|---|
| Privacy by default (no third-party requests unless opted in) | 12 | 2 | 2 | 5 | 5 | 4 |
| Licence and provider-terms risk | 12 | 4 | 3 | 4 | 5 | 3 |
| Sync quality we can reach | 12 | 3 | 3 | 5 | 4 | 4 |
| Content coverage (what members will actually watch) | 12 | 4 | 5 | 2 | 3 | 5 |
| Reliability (embed breakage, ads, region locks) | 8 | 2 | 2 | 4 | 3 | 3 |
| Effort and upkeep (5 = cheap) | 12 | 3 | 3 | 2 | 5 | 2 |
| Fit with modules, permissions, audit, E2EE | 12 | 1 | 4 | 4 | 5 | 5 |
| Meets the request (watch list, sync controls, who is watching) | 20 | 4 | 5 | 3 | 1 | 5 |
| **Weighted total (max 500) / percent** | | **300 / 60** | **356 / 71** | **356 / 71** | **368 / 74** | **400 / 80** |

Working: E = 4×12 + 3×12 + 4×12 + 5×12 + 3×8 + 2×12 + 5×12 + 5×20 = 48+36+48+60+24+24+60+100 = 400.

Sensitivity (computed the same way): the margin of E over D (400 against 368) is small and comes entirely from "meets the request" and content coverage. Doubling the weights of privacy and licence makes it a tie (E 484, D 488 of a 620 maximum, 78.1% against 78.7%); with "meets the request" at weight 0 D wins outright. So the scores do not prove E is best on privacy; they say E is the best option **that does what was asked**, and D is what to fall back to. That is why D is kept as the documented fallback and why the YouTube adapter is opt-in. If the owner decides **no third-party embeds at all**, the answer becomes E without the YouTube adapter, which is C plus D (the plan already ships HTML5 first, so nothing is wasted).

## 5. Decision (recommended)

1. **Build our own sync engine.** A server-authoritative room clock in a new `watch` module, a provider-neutral client sync controller, and a `PlayerAdapter` interface. This is the part every option needs and no existing code can be reused (licence, language, accounts).
2. **Ship the HTML5 adapter first** (own `<video>`, `media-src 'self'`, allow-listed direct HTTPS hosts, and later member uploads through the `uploads` module). It is the only adapter where we control play, pause, seek, rate and buffering, so it is where the sync algorithm is proven and where the CI media test runs.
3. **YouTube is the second adapter, off by default, enabled per server by the owner**, using the IFrame API with the `youtube-nocookie.com` host, the HTTP `Referer` handled per iframe (§7), and a plain-language privacy notice before a member's first YouTube item loads in their browser. It is labelled **best effort** until spike S3 shows what ads, discrete rates and keyframe seeks do to sync.
4. **Vimeo, PeerTube, Twitch VODs and Dailymotion are not in the first release.** The adapter interface is written so each is a small addition (PeerTube first: AGPL, self-hosted, no ads, per-instance allow-list). Twitch live and Dailymotion are out unless the owner asks (no time sync, no position getter).
5. **Screenshare stays the documented fallback** for anything else (DRM-free local files, services without embeds). It is E2EE-protected and needs no server work; the UI offers a "Share instead" hint.
6. **No server-side media handling** in this decision: no download, no proxy, no transcoding, no re-streaming of provider video (it would breach the YouTube terms and add legal exposure). Member uploads are served as-is from the file store.
7. **The server never fetches a member-supplied URL.** It builds fixed provider oEmbed requests from a validated video ID (OWASP's "build the request yourself"); direct-URL items get no server fetch at all. This removes the SSRF class for v1 (security review §3).

## 6. Alternatives rejected, and why

- **A, adopt SyncTube or similar.** MIT licence is fine, but it brings its own accounts, permissions and moderation, a second runtime (Haxe), a leader-only model with a 2 s threshold, "iframes without sync", and none of our audit, CSP or E2EE story. Its constants are used as references only.
- **B, embed-only.** Highest coverage, but the default experience would send every member's IP to third parties, depends on providers whose terms can change, and cannot be tested in CI. Kept as the *second* layer of E, not the base.
- **C, HTML5 only.** Best privacy and sync, but members mostly want YouTube links; without it the channel will feel empty. Kept as the *first* layer of E.
- **D, screenshare only.** Already built and E2EE-clean, but there is no queue, no per-viewer volume or pause, the sharer's upload and CPU carry the room, DRM or protected content renders black (U), and it does not meet the request. Kept as the fallback.
- **Own media pipeline (transcoding, HLS packaging).** A heavy dependency (ffmpeg), CPU on a small VPS, and content-hosting exposure. Deferred; if uploads need it, it is a separate ADR.
- **Proxying or re-streaming provider video** to remove the IP leak: prohibited by the YouTube terms we read and likely by others. Not an option.
- **Isolating the YouTube player in our own sandboxed iframe** to contain Google's script: reported as prohibited (nested frames, U). The mitigation is opt-in, the HttpOnly cookie, a minimal CSP allowance and a clear owner warning. Spike S7 reads the policy text itself.

## 7. Consequences

- New module `watch`, new channel kind `watch`, four new permission bits, a gateway and REST surface, a client module with the adapter interface. Effort L for the core plus M for each added capability, see [21](21-watch-together-plan.md).
- **Shared component:** a hardened `safe-fetch` package (resolve once, connect to the address, redirect cap, size and time limits, no cookies) is needed by the oEmbed fetcher and is also what `link-previews` always needed (15 §4.3). It is the first task.
- **CSP and headers change when providers are enabled.** The generated Caddyfile gains `frame-src`, `script-src`, `img-src` and `media-src` entries **only for providers the owner enabled**, and `tincan doctor` checks that the live header matches the config. The shipped `Referrer-Policy: no-referrer` conflicts with YouTube's Referer requirement (error 153 otherwise): the plan sets `referrerpolicy="strict-origin-when-cross-origin"` on the player iframe only (an iframe attribute overrides the document policy; whether `YT.Player` honours an iframe we create ourselves is unverified, spike S3) and leaves the site-wide header alone.
- **`CHANNEL_SCOPED` is a contiguous mask of bits 0 to 14** (`packages/shared/src/permissions.ts`), and all 15 channel-scoped bits are taken. New channel-scoped bits (27 and up) cannot be overwritten per channel until that constant becomes an explicit set. This is a small change to the permission code with a test, and it must land first (design 20 §5).
- The 30-day storage rule (U) becomes a data-retention job for YouTube-derived titles and thumbnails.
- A watch channel promises **nothing about E2EE** and the UI says so (design 20 §11).

## 8. What would change this decision

| If | Then |
|---|---|
| The owner wants no third-party requests ever | Drop adapter 2; ship HTML5 + uploads + screenshare (C + D). Nothing built for E is wasted |
| Spike S3 shows YouTube ads or discrete rates break sync beyond usability, and no workaround | Mark YouTube "no sync guarantee" (shared queue and approximate sync only) or drop it |
| YouTube changes or enforces terms against sync or programmatic control, or the policy text confirms the nested-iframe ban applies to our design | Re-score B and E; a compliance audit is offered by Google for doubtful cases (V: the developer-policy guide says to apply for one), ask before launch |
| The owner needs a public (open-signup) instance | Uploads and arbitrary direct URLs stay off; moderation tooling (design 20 §9) becomes a launch blocker; counsel first |
| Member uploads become the main use | Range-request serving and a transcoding decision move to the front (a new ADR) |
| A permissively licensed, maintained sync library appears that handles the adapter problem | Re-score A against the written criteria; adopting a library inside our module does not change this ADR's shape |
| Safari/iOS spikes (S5) show programmatic play cannot be made to work | The phone experience is "join and press play", documented; desktop remains the supported path |

## 9. Sources (all accessed 2026-11-02)

YouTube: [IFrame Player API reference](https://developers.google.com/youtube/iframe_api_reference), [player parameters](https://developers.google.com/youtube/player_parameters), [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality), [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) (first 39k characters verbatim, rest summary), [Developer Policies guide](https://developers.google.com/youtube/terms/developer-policies-guide), [API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service), [Terms of Service (English, 5 Jan 2022)](https://www.youtube.com/t/terms?hl=en&override_hl=1), [Embed help / privacy-enhanced mode](https://support.google.com/youtube/answer/171780), [oEmbed example](https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=json).
Others: [Vimeo player.js](https://github.com/vimeo/player.js), [Vimeo oEmbed example](https://vimeo.com/api/oembed.json?url=https://vimeo.com/76979871), [Twitch embed overview](https://dev.twitch.tv/docs/embed/) and [video and clips](https://dev.twitch.tv/docs/embed/video-and-clips/), [Dailymotion Web SDK methods](https://developers.dailymotion.com/reference/web-sdk-player-methods.md), [events](https://developers.dailymotion.com/reference/web-sdk-player-events.md), [oEmbed](https://developers.dailymotion.com/docs/embed-with-oembed.md), [PeerTube embed API](https://docs.joinpeertube.org/api/embed-player), [oEmbed spec](https://oembed.com/).
Sync projects: [Jellyfin web SyncPlay core](https://github.com/jellyfin/jellyfin-web/tree/master/src/plugins/syncPlay/core) (`PlaybackCore.js`, `timeSync/TimeSync.js`, `Manager.js`), [WaitingGroupState.cs](https://raw.githubusercontent.com/jellyfin/jellyfin/master/MediaBrowser.Controller/SyncPlay/GroupStates/WaitingGroupState.cs), [Syncplay constants.py](https://raw.githubusercontent.com/Syncplay/syncplay/master/syncplay/constants.py), [Syncplay client.py](https://raw.githubusercontent.com/Syncplay/syncplay/master/syncplay/client.py) (partly summary), [SyncTube](https://github.com/RblSb/SyncTube) (`src/server/VideoTimer.hx`, `Main.hx`, `src/client/Main.hx`, `Player.hx`), [Jellyfin issue 11302](https://github.com/jellyfin/jellyfin/issues/11302) (snippet only).
Platform: MDN [Autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay), [playbackRate](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate), [requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [Media Session](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API), [Page Visibility](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API), [CSP frame-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src), Permissions-Policy [autoplay](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/autoplay), [fullscreen](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/fullscreen); [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html); [hls.js](https://github.com/video-dev/hls.js), [dash.js](https://github.com/Dash-Industry-Forum/dash.js), [Plyr](https://github.com/sampotts/plyr), [vidstack](https://github.com/vidstack/player).
Law (secondary): [GS Media v Sanoma](https://en.wikipedia.org/wiki/GS_Media_v_Sanoma), [Server test](https://en.wikipedia.org/wiki/Server_test). The Court of Justice texts could not be retrieved.

**Not found or not fetched (do not rely on):** official statement of what `youtube-nocookie.com` sets before play; Vimeo terms and the `dnt` embed option; Twitch Developer Services Agreement; the YouTube Developer Policies after character 39,000 (summary only); `playsinline`/autoplay rules for Chrome and WebKit blog pages; Syncplay's protocol file; Jellyfin's server constants (`MaxPlaybackOffset` and others); Video.js and PeerTube embed-api licences.

## Open items
- Owner decisions: [22](22-watch-together-owner-memo.md).
- Spikes S1 to S8: [21 §3](21-watch-together-plan.md).
