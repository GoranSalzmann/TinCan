# 21. Watch Together: milestone plan, spikes and test plan

> **Status: Proposed (planning only, 2026-11-02).** Sits in [17 §3a](17-roadmap-and-milestones.md) as the post-1.0 milestone **M8**. Estimates use the scale of 17 (S ≈ days, M ≈ 1 to 2 weeks, L ≈ 3 to 5 weeks, ±50 %, one full-time developer; here "you plus Claude" as in 17 §5). Decision: [19](19-watch-together-adr.md). Design: [20](20-watch-together-design.md). Security: [security/watch-together-review.md](security/watch-together-review.md). Demo checklist: [qa/watch-together.md](qa/watch-together.md).

## 1. Shape

```
 S1–S8 spikes ─▶ W0 foundations ─▶ W1 core + HTML5 ─▶ W2 YouTube ─▶ W3 uploads (optional) ─▶ W4 hardening ─▶ release 1.1
   (M)               (S)              (L)              (M)            (M)                     (M)
```

Each slice ends with something usable and can ship as a minor release behind `modules.watch.enabled: false`. **Cut lines** (decide now): W3 can be dropped entirely; W2 can be dropped if S3 or S7 say so; W1 (HTML5 + sync engine + queue) and W4 are the minimum worth shipping.

## 2. Effort

| Slice | Size | Calendar (one person, ±50 %) | Notes |
|---|---|---|---|
| Spikes S1 to S8 | M | 1 to 1.5 weeks | Run in parallel where possible; S3, S4, S7 need a real browser and a person |
| W0 Foundations | S | 3 to 5 days | `safe-fetch`, permission bits and `CHANNEL_SCOPED`, `ChannelKind`, config schema, `tincan config apply` skeleton |
| W1 Core + HTML5 | L | 3 to 4 weeks | Module, protocol, controller, adapter interface, HTML5 adapter, queue UI, phone layout, audit, metrics |
| W2 YouTube | M | 1 to 2 weeks | Adapter, notice and consent, CSP generation, doctor checks, oEmbed |
| W3 Uploads as items | M | 1 to 2 weeks | Range serving, claim/release in `uploads`, `ADD_WATCH_FILES`, quota, takedown tooling |
| W4 Hardening | M | 1 to 2 weeks | Simulator suite, media test in CI, security re-review, QA, docs, takedown guide |
| **Total** | | **about 8 to 12 weeks** (7 to 10 without W3) | Spikes may move numbers; dates depend on review cadence |

## 3. De-risking spikes (what to prototype first)

Spike code lives in `spikes/watch-*/` with a `RESULTS.md`, as in M0. Order: S7 and S4 first (they decide whether YouTube is worth building), then S1, S2, S3, S6, S5, S8.

| ID | Question | What to build | Exit criteria (numbers decide, not opinions) |
|---|---|---|---|
| S1 | Is the clock sync and command path accurate and fast enough on the real stack (single SQLite node, gateway, reverse proxy)? | `clock.ping` over the real gateway; the min-RTT estimator; a stub `watch_room` with the persist-then-broadcast path; clients on a fast link and on a simulated 80 ± 30 ms, 2 % loss link (network emulation) | p95 clock-offset error ≤ 40 ms on the lossy link with the min-RTT-of-8 estimator (also try median and a Kalman variant, keep the simplest that passes); command-to-fan-out server time p99 ≤ 30 ms with 50 sockets and one SQLite write per command; numbers in `RESULTS.md`, copy into 20 §6.9 |
| S2 | Does rate nudging plus seeking converge for the HTML5 element without audible or visible artefacts, across browsers? | Two to three pages, a static test video with a visible frame counter and audio click track; the controller of 20 §6.5 with tunable constants; Chromium, Firefox, and Safari or WebKit if available | From a 1 s offset: within ±150 ms in ≤ 8 s and no more than 2 rate changes per 10 s once converged; seeks ≤ 1 per correction; rate range 0.92 to 1.08 inaudible by ear on speech (a person listens); constants chosen and written into 20 §6.5; browsers where `playbackRate` is ignored or clamps are listed |
| S3 | Can the YouTube adapter reach usable sync, and under our CSP and headers? | The adapter against the real IFrame API: `controls=1`, `enablejsapi=1`, `origin`, `autoplay=0`; our own iframe with `referrerpolicy`; echo suppression; seek accuracy for buffered and unbuffered positions; discrete rate list; behaviour during ads; `onAutoplayBlocked`; error codes 100/101/150/153 | Steady-state error ≤ 600 ms for ≥ 90 % of 10-minute runs on ordinary videos; list of what the API reports during ads (position, duration, state) and what we do about it; confirmation that an iframe we create carries the Referer and does not give 153 under `Referrer-Policy: no-referrer`; the exact script hosts needed by CSP; if the exit is not met, YouTube is labelled "no sync guarantee" or dropped (ADR 19 §8) |
| S4 | What does the privacy-enhanced embed really send and set, before and after play? | A page with the embed under a controlled profile; capture network requests, cookies, local storage with devtools/Playwright (HAR) for: load, load plus JS API, play, after 60 s | A table of third-party hosts, cookies and storage before play and after play, dated; the member notice text is written from it; if cookies or Google requests happen before play, the notice and the "load only after Join" rule are tightened |
| S5 | Phone, PWA and echo behaviour | iOS Safari, Android Chrome, installed PWA, iPad: autoplay after a tap, `playsinline`, remote play of Vimeo (skip if not shipping), background and lock-screen behaviour of HTML5 and YouTube, Media Session; a call plus a video on speakers: does the mic pick up the video, does AEC cancel an iframe's audio? | Support matrix written into 12 §14 and the user guide; decision on auto-duck default; the phone "Tap to play" path confirmed or redesigned |
| S6 | Can uploaded video play and seek via our file route? | Add `Range`/`206` to the file route in a branch; `<video>` with cookie auth; mp4 (H.264/AAC) and webm | Seeking works in Chromium, Firefox and Safari; malformed range tests pass; memory use flat for a 1 GiB file; known unplayable codecs listed (we do **not** transcode) |
| S7 | What do the policy texts actually say about nested frames, 30-day storage, consent for remote control, `controls=0`? | Read the full Developer Policies, RMF and the audit option, verbatim (the earlier read had only the first 39k characters of the policies); write a clause table. Optionally ask Google's API compliance audit | A table of clauses with verbatim quotes and our reading; decisions: may we isolate the player in our own frame (changes security review §3.3), do we need the 29-day text purge, is the consent flow enough; if still unclear, the owner decides whether to request the audit (memo D4) |
| S8 | Does `safe-fetch` hold? | The package and its test suite written first, with a local test harness that simulates rebinding, redirects, IPv4-mapped IPv6, slow and oversize bodies | The suite passes; an outside-in test against a local listener on 127.0.0.1 and 169.254.169.254-style addresses finds no connection; reviewed by a second reader (or the owner buys an external look, memo D8) |

Spikes S1, S2, S6, S8 are code you keep; S3, S4, S5, S7 produce data and text.

## 4. Task list by slice

### W0 Foundations (S)
1. `packages/safe-fetch` with tests (S8 delivers it). Used by the oEmbed fetcher; `link-previews` will adopt it later.
2. Permissions: bits 27 to 30 in `PERMISSION_BITS`; `CHANNEL_SCOPED` as an explicit set; `ChannelKind` and `channelKindMask("watch")`; default-role bundles; `TIMEOUT_REMOVES`; tests.
3. Channels: accept type `watch`, call a settings validator hook registered by the module; web channel-create dialog shows the type only when the capability is present.
4. Config: `modules.watch` zod section; capability block; boot-matrix entry (`watch` depends on `channels`, `roles`).
5. `tincan config apply` (or the smallest equivalent): regenerate and validate the Caddyfile from config, and `tincan doctor` checks for the provider headers.

### W1 Core and HTML5 (L)
1. Migration `watch_room`, `watch_item`, `watch_skip_vote`, `watch_blocklist`, `watch_meta`; table types; migration test on an empty DB and on a populated 1.0.x DB.
2. `packages/shared/src/watch/`: wire schemas, URL canonicaliser (HTML5 host rules, provider ID patterns), position maths, clock estimator, drift controller, echo-suppression helper. **Pure and DOM-free** so the simulator can run them.
3. Server `room.ts`: in-memory room runtime, serialised command handling, anchor model, scheduled start, group wait, ended quorum, viewer presence with 10 s grace, restore on boot.
4. Gateway ops and events; REST routes; permission checks; rate limits; `STALE_ITEM`; audit events (`watch.item.added|removed`, `watch.settings.changed`, `watch.blocklist.changed`); reconciler job; metrics.
5. Client `modules/watch/`: store slice, snapshot and resume handling, `PlayerAdapter` interface, **HTML5 adapter**, `SyncController`, stage, transport bar, queue panel with reorder, add bar, viewers tab, notices, phone layout, accessibility pass (20 §9.3).
6. Settings UI: channel Watch section; server section for the module.
7. Docs: user guide (watching together), admin guide (enabling, providers, host allow-list, CSP).

### W2 YouTube (M)
1. YouTube adapter (IFrame API loaded on Join only), echo suppression, discrete-rate nudging, ad handling from S3, error mapping.
2. oEmbed fetch with `safe-fetch`, ID extraction suite (adversarial strings), cache, limits.
3. Provider notice and the `watch.provider.youtube.accepted` synced setting; link to YouTube's Terms and Google's privacy policy; the API-terms sentence in the Host's terms/guide if a Host publishes any (admin guide text, verified requirement III.A).
4. CSP and header generation per enabled provider; golden-file tests; doctor checks.
5. Data retention job for YouTube-derived text.
6. Optional: apply for Google's compliance audit (owner decision, memo D4).

### W3 Member uploads as watch items (M, optional)
1. `Range`/`206` on the file route (S6) with security tests (SW-09).
2. `UploadsApi` claim/release so a queued file is not collected as an orphan; quota unchanged.
3. `ADD_WATCH_FILES`, allowed types (mp4, webm), size cap per file for watch items, UI in the add bar.
4. Takedown tooling: find by id or hash, remove item and file, audit; admin-guide chapter.
5. Decision on transcoding (a new ADR if wanted; not in this plan).

### W4 Hardening (M)
1. Simulator suite and scenarios (§5.1), tuned constants frozen.
2. Two-browser media test `tools/watch-test` and its workflow (§5.2).
3. Authorisation matrix rows, SSRF suite, CSP golden files, request-interception test, log-redaction test, reconciler test, load numbers (50 viewers × 20 rooms with `tools/load`).
4. Security review re-run with evidence (security review §8, §10).
5. QA checklist run on real devices; fix list; the "if you get a takedown request" guide; CHANGELOG and release notes (`docs/release-notes-template.md`).
6. Update docs 04, 06, 07, 11, 12, 15, 16 with "as built" notes in the project's style.

## 5. Test plan

### 5.1 Deterministic sync simulator (unit level, runs in `pnpm test`)
A Vitest suite around the pure library with a **virtual clock** and a seeded random generator (no real timers, no network, no browser), so a failure is reproducible from a seed.

- **Model:** one server room (the real `room.ts` logic with an in-memory store), N virtual clients each with: a clock offset and skew (ppm), a link with latency, jitter, asymmetry and loss, a **fake adapter** that obeys configurable realism (seek latency, keyframe-granular seeks, discrete playback rates, rate-change refusal, start latency, buffering stalls, ads that freeze position, tab throttling that skips ticks).
- **Scenarios (each asserts bounds on steady-state error, time to converge, and number of corrections):** all in sync from start; late join mid-play; join while paused; seek storm from three controllers; pause and play with scheduled start under 300 ms asymmetry; one slow buffering client with the wait (and the 8 s cap and 2-wait cap); client reconnect and resume; non-resumable reconnect; server restart (< 15 s and > 15 s); clock offset step (laptop sleep); 200 ppm skew over 2 hours; YouTube-like adapter (discrete 0.25 rates, keyframe seeks); rate-refusing adapter (fallback to seeks); hidden-tab throttling; control-mode revert of a forbidden seek; echo suppression (no ping-pong across 1,000 simulated commands); permission loss during play.
- **Properties:** never more than 6 seeks per minute per client; rate stays within 0.92 to 1.08; no oscillation (rate sign changes ≤ 2 per 10 s after convergence); position never goes backwards unless a command says so; the group wait ends by `waitUntilMs`; `ended` cannot be triggered by one of two viewers.
- **Property tests** (fast-check or a seeded loop) over random command sequences keep the room invariants (`epoch` strictly increasing, `waiting` never persists, queue order is a total order).
- Time budget: the whole suite under 20 s in CI.

### 5.2 Two-browser media test (`tools/watch-test`, modelled on `tools/media-test/run.ts`)
Real server, real web client, two (later three) headless Chromium pages, a generated test video (a few seconds of a counter and tone, produced at test start with canvas and `MediaRecorder` or a small committed file, no download), no external network.
- Steps: create a watch channel; both join; A adds the item by allow-listed `127.0.0.1`-style host and by upload (W3); A plays; **sample `currentTime` of both pages at the same instant** through CDP and assert the difference stays within 150 ms for 30 s; B pauses, A resumes; seek by A moves B within one second; B reloads and rejoins mid-play; B's network is throttled (CDP `Network.emulateNetworkConditions`) and the group wait is observed; permission removed from B and B's controls vanish; B banned: B is out within the reconciler interval; **zero requests to provider hosts** before Join (request interception).
- Runs in the existing Docker flow (`tools/media-test/docker.sh` pattern) and a new workflow `watch.yml` on pull requests that touch `modules/watch`, `packages/shared/src/watch`, or the client module. LiveKit is not needed for this test (a combined run with voice joined is a later optional step to check that the call and the player coexist).
- **YouTube cannot be tested in CI** (external service, terms, ads): a manual QA section plus an optional non-blocking **canary** job that loads the oEmbed endpoint and the IFrame API script and checks that the CSP-listed hosts still serve it, run nightly or weekly and reporting only.

### 5.3 Other layers (as 16)
| Layer | Content |
|---|---|
| Unit | URL and ID canonicaliser, hostile strings; permission maths; sort-key `between`; settings schemas |
| Module | `watch` boot matrix; disabled-module test (no routes, no gateway ops, no capability); migrations on a populated DB |
| Integration | REST and gateway flows with the harness (`apps/server/src/testing/harness.ts`); the auth matrix; rate limits; the reconciler with a failed first removal |
| Security | SSRF suite (`safe-fetch`), CSP golden files (`templates.test.ts`), request interception, log redaction (SW-01 to SW-12) |
| Client | Component tests for stage, queue, join gate, notice, revert message; accessibility checks (labels, live region) |
| Load | `tools/load` scenario: 20 rooms × 10 viewers, commands every few seconds, fan-out latency and event loop lag recorded |
| Manual | [qa/watch-together.md](qa/watch-together.md) on real phones and browsers |

Definition of done for each slice follows 16 §15: requirements mapped to tests, works with the module off and on, docs and capabilities updated, accessibility pass, metrics and logs, no unaddressed item in the security review.

## 6. Observability checklist
Metrics and log rules are in 20 §12. Add to the Host's Grafana notes (14 §9): alert on `tincan_watch_waits_total{outcome="timed_out"}` rate and on command latency p99 above 100 ms.

## 7. Dependencies and critical path
`safe-fetch` and the permission change (W0) gate everything; the simulator and the pure library (W1.2) can start immediately and are the main de-risking of the sync algorithm; S7 and S4 gate W2; S6 gates W3. Nothing here touches voice, LiveKit or E2EE code, so M3 to M5 behaviour is not at risk; a regression guard is the unchanged media test (`26/26`).

## 8. Risks to this plan

| Risk | Effect | Mitigation |
|---|---|---|
| YouTube behaviour (ads, rates, keyframe seeks) makes sync poor | W2 value drops | S3 first; "best effort" label; HTML5 adapter carries the sync story |
| Policy text forbids a design choice (nested frame, consent) | Rework of CSP/isolation, or YouTube dropped | S7 first; adapter isolated behind the interface |
| Browser differences (Safari autoplay, iOS programmatic play) | Phone experience weaker | S5 early; "Tap to play" path designed in |
| Scope creep (playlists import, speed control, reactions, subtitles) | Slips | They are listed as deferred in 20; adding one needs a decision |
| Uploads pull in transcoding, Range, takedown | W3 balloons | Optional slice; no transcoding; owner decision D6 |
| Single-developer capacity after v1.0 | Calendar | Cut lines in §1 |

## Open items
- Owner decisions: [22](22-watch-together-owner-memo.md).
- Calendar dates (need availability).
