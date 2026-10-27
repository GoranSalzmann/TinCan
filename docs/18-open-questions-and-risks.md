# 18. Open Questions & Risks (living document)

Updated with every batch. Section A is fully resolved; new questions will be
added there as later batches surface them.

## A. Product decisions

| ID | Question | Why it matters | Decision |
|---|---|---|---|
| Q1 | **D9:** One community per install, or several "spaces"? | Affects UI, permissions, invites | **Resolved:** one community; schema carries `space_id` so upgrade is easy |
| Q2 | Direct messages / group DMs in v1? | New channel type, privacy rules | **Resolved:** no DMs in v1 (would be a `dm` channel type later, see 06) |
| Q3 | Threads in text channels? | Data model + UI complexity | **Resolved:** no threads |
| Q4 | Search scope | Query/index design | **Resolved:** global across channels the user can see |
| Q5 | Attached text chat for voice channels? | Common Discord expectation | **Resolved:** no; admins create a paired text channel manually |
| Q6 | Project licence | Must precede first public commit | **Resolved:** AGPL-3.0 (ADR-018); `-only` vs `-or-later` and DCO vs CLA still to pick at scaffold |
| Q7 | Product name | Package names, installer IDs | **Resolved:** **Tin Can** |
| Q8 | Admin web UI for module toggles | Restart-to-apply config is simpler | **Resolved:** later; config file only in v1 |
| Q9 | Public open-signup instances vs friends-only | Moderation depth, abuse tooling | **Resolved:** invite-only default (open signup stays a config toggle) |
| Q10 | Mobile | Whether audio/E2EE work must stay portable | **Resolved:** web-responsive only; keep audio and E2EE code free of desktop-only assumptions |

### Follow-on items created by these decisions

| ID | Item | Doc |
|---|---|---|
| F1 | AGPL section 13: add configurable "Source code" link in About dialog and `/capabilities` | 03, 12, 13 |
| F2 | CI licence scanner rejecting incompatible dependencies; bundle third-party notices | 03, 16 |
| F3 | Pick SPDX identifier (`AGPL-3.0-or-later` recommended) and DCO vs CLA | 03 |
| F4 | Use "tincan" as the technical slug: npm scope `@tincan/*`, Docker image `tincan`, Electron appId `app.tincan.desktop` (check name availability and trademark conflicts before publishing) | 14, 13 |
| F5 | Rename folder `SelfHostedChat` to `TinCan` when convenient | n/a |

## B. Technical open items (carried from docs)

| Ref | Item | Doc |
|---|---|---|
| T1 | Fastify vs Hono final pick | 03, 05 |
| T2 | Kysely vs Drizzle final pick | 03, 06 |
| T3 | Cert sharing Caddy ↔ LiveKit TURN/TLS. **Proposed (14 §2.3):** shared read-only cert volume, TURN/TLS on 5349; TURN on 443 via SNI router is an optional advanced setup; confirm in D6 | 03, 14 |
| T4 | ~~UDP strategy~~ **Resolved (08 §3.2):** single UDP mux port 7882 + TCP 7881 + TURN/TLS; confirm in spike D6 | 02, 08, 14 |
| T5 | ~~Webhook exposure~~ **Resolved (14 §2.1):** `/api/internal/*` blocked at Caddy; LiveKit calls the app over the internal Docker network | 05, 14 |
| T6 | ~~E2EE key storage and rotation~~ **Resolved (10 §4):** HKDF-derived from instance secret, epoch counter in kv, rotation policy table | 06, 10 |
| T7 | ~~Permission bitset width~~ **Resolved (11 §2.2):** unsigned 64-bit, BigInt, decimal-string on the wire, globally stable bit positions | 06, 11 |
| T10 | Typing events: gateway-only vs also REST (recommend gateway-only) | 07 |
| T11 | Verify all LiveKit values marked "(verify)" in 08 and 10 against pinned versions | 08, 10 |
| T12 | Active-speaker detection under E2EE (server cannot measure encrypted audio) | 08, 10 |
| T13 | 2FA (TOTP) as v1.1 module; account deletion default; user data export timing | 11 |
| T14 | Pop-out stream windows: shared Room vs second connection | 08, 13 |
| T15 | Echo handling for screenshare system audio | 09 |
| T16 | Ship RNNoise tier at all, or DeepFilterNet + browser fallback only | 09 |
| T17 | E2EE default on for new installs (recommended yes); browser-support policy for Firefox/Safari | 10 |
| T8 | ~~Web client hosting~~ **Resolved (14 §2.1):** static files served by Caddy | 02, 14 |
| T9 | ~~Admin CLI packaging~~ **Resolved (14 §9):** `tincan` CLI wraps `node server.js admin …`, one artifact | 05, 14 |
| T18 | electron-builder vs Electron Forge; Linux formats at v1 (AppImage + deb first) | 13 |
| T19 | Persistent local message cache (IndexedDB) in v1; TanStack Query vs bespoke REST cache | 12 |
| T20 | Separate origin for user-uploaded content by default vs optional | 15 |
| T21 | LiveKit `network_mode: host` vs published ports as compose default | 14 |
| T22 | Gateway resume ring-buffer placement when running multiple app nodes | 14 §10 |
| T23 | Missing deliverable: UI/UX design (wireframes, design tokens, brand, icon) | 12, 17 |
| T24 | Calendar dates and weekly time budget to turn sizes in 17 into a schedule | 17 |

## C. Risk register

Likelihood (L) and impact (I): H/M/L.

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| K-01 | Users cannot connect media because of UDP/NAT/firewall issues | H | H | Built-in TURN on 443/TLS, connectivity-check page in the client, clear Host docs, startup self-test |
| K-02 | Server bandwidth exhausted by screenshare fan-out | M | H | Documented sizing; per-channel bitrate cap; simulcast + adaptive stream; low-upload and viewer-quality controls; warn Host in docs about metered VPS |
| K-03 | Dependency on LiveKit (breaking changes, licence change, abandonment) | L | H | Pin versions, track releases, keep LiveKit calls inside few modules; accept lock-in knowingly (ADR-002) |
| K-04 | Neural denoiser costs too much CPU on low-end machines or has glitches | M | M | Auto-fallback to RNNoise/browser NS; presets; off switch; benchmark in CI on reference hardware |
| K-05 | Wayland (Linux) screen capture and global hotkeys behave differently | H | M | Test matrix includes GNOME/KDE on Wayland; PipeWire portal path; X11 fallback; document limits |
| K-06 | macOS system-audio capture during screenshare unsupported or needs extra permissions/driver | H | M | Declare as known limitation; offer window/app capture without audio; investigate ScreenCaptureKit-based path in Electron |
| K-07 | Electron security misconfiguration | M | H | Hardened defaults, contextIsolation, sandbox, strict CSP, no remote code, review checklist (13, 15) |
| K-08 | SQLite write contention under busy chat | L | M | WAL, single writer queue, batch ops; Postgres escape hatch |
| K-09 | Dual-DB support doubles testing/bugs | M | M | Common SQL subset; CI on both; SearchIndex is the only divergence |
| K-10 | Webhook loss → wrong presence | M | M | Idempotent handlers + reconciliation job + client-side tolerance |
| K-11 | E2EE gives false sense of security (Host controls key distribution) | M | M | Document threat model plainly (10); no overclaiming in UI |
| K-12 | Scope creep from "extremely modular" ambitions | H | M | Bounded modularity (ADR-003/004), no plugin API in v1, build order in 17 |
| K-13 | Abuse on public instances (spam, illegal uploads) | L | H | Invite-only default, rate limits, upload limits, moderation tools; legal notes in Host docs |
| K-14 | Auto-update/signing costs (Apple notarisation, Windows code signing) | H | M | Budget for certificates; unsigned dev builds documented; evaluate SignPath/free OSS options |
| K-15 | Browser codec/feature differences (AV1, screen audio) | M | L | Capability detection, codec preference list with VP8/H.264 fallback |
| K-16 | Single developer bus factor / burnout | M | H | Prioritised milestones, finish voice+text first, defer extras |
| K-17 | Routing remote audio through Web Audio (volume boost >100%) degrades echo cancellation | M | M | Keep playback on media elements by default; boost flagged as headphones-only; validate in spike D2 (09 §7) |
| K-18 | LiveKit server-side active-speaker detection unavailable under E2EE, hurting speaking indicators | H | M | Client-computed levels shared via gateway/participant attributes; validate in spike D4 (10 §6) |
| K-19 | Several facts about LiveKit/DeepFilterNet in 08–10 come from memory, not the pinned versions | M | M | Mark as "(verify)", spike D1/D2/D4 before treating as fact; update docs after spikes |
| K-20 | No global hold-to-talk in v1 (and no global shortcuts on some Wayland sessions); gamers may want it | H | M | Decided (18 §F): in-window PTT + global toggle-mute/deafen/leave + `tincan --toggle-mute` CLI; native hook is a v1.1 option (13 §4.2) |
| K-21 | Fresh instance exposed before setup could be claimed by a stranger | L | H | One-time setup token printed to server logs/file (11 §1.4) |
| K-22 | Home hosts behind CGNAT cannot receive media connections | M | M | `doctor` detection, VPS recommendation, relay/tunnel docs (14 §1) |
| K-23 | ~~macOS Input Monitoring friction~~ Removed from v1 by the no-native-hook decision; returns only if the v1.1 hook is built | L | L | 13 §4.2.3 |
| K-24 | GPU/driver bugs cause black video or crashes in Electron | M | M | Hardware-accel toggle, auto safe-mode after repeated GPU crashes (13 §7) |
| K-25 | Electron/Chromium security patches require fast desktop releases | H | M | Automated dependency PRs, release checklist, auto-updater (13 §11, 15 §9) |
| K-26 | Bundled renderer can fall out of sync with newer servers | M | M | `apiVersion` negotiation, update prompts, additive-change policy (07 §6, 13 §2) |
| K-27 | No UI/UX design exists yet; risk of an unpolished product | H | M | Design pass in M0/M2, restrained design system (17 §5, T23) |
| K-28 | Test infrastructure (media, multi-OS) is costly to build and may flake | M | M | Layered strategy, manual matrix as backstop, quarantine policy (16) |

## D. Assumptions to validate early (spike list)

Referenced elsewhere as D1 to D6.

- **D1.** LiveKit self-hosted on a cheap VPS: measure CPU/egress for 1 publisher at 1080p30 → 5 viewers; confirm dynacast keeps publisher upload flat as viewers increase; verify (08) config values.
- **D2.** DeepFilterNet WASM worklet: CPU and latency on a low-end laptop; quality vs RNNoise vs browser NS on recorded samples; AEC behaviour with Web Audio playback (K-17); model licence check.
- **D3.** Electron `desktopCapturer` with audio on Windows/Linux; behaviour on Wayland and macOS.
- **D4.** LiveKit E2EE + simulcast + dynacast (+ VP9/AV1 SVC) working together; active-speaker approach under E2EE (K-18).
- **D5.** Dual-dialect migration tooling (Kysely/Drizzle) with FTS divergence.
- **D6.** TURN/TLS on 443 sharing a port/cert with Caddy (T3, T4); single-port UDP mux behaviour.

## E. Sign-off checklist

- [x] Q1–Q10 answered
- [x] All docs 00–17 written (drafts complete)
- [ ] All docs 00–17 reviewed by you (batch 1 and 2 partially; batch 3 pending)
- [ ] Spikes D1–D6 scheduled (not necessarily done)
- [ ] Roadmap (17) accepted
- [x] Licence and name chosen (AGPL-3.0, Tin Can)

## F. Sign-off triage outcome (2026-10-27)

### Decided by you
| Ref | Decision | Effect on docs |
|---|---|---|
| T17 | **E2EE is on by default** for new installs and new voice channels (Hosts can turn it off globally or per channel). Browsers lacking the needed APIs are refused on `required` channels. | 10, 04 (config default `voice.e2ee: true`), 14 (`tincan init` default) |
| F3 | **AGPL-3.0-or-later** (SPDX `AGPL-3.0-or-later`) with **DCO** sign-off for contributors. No CLA; commercial relicensing would need every contributor's consent. | 03 ADR-018 |
| T23 | **Claude drafts low-fi wireframes and a token/style guide in M0**; you approve before UI code starts. | 17 M0 |
| T24 | **You plus Claude doing most of the coding.** You steer and review; implementation proceeds milestone by milestone. Pace depends on your review time, not coding time. | 17 §5 |

### Accepted recommendations
T10 typing events gateway-only · T13 2FA/export/deletion semantics deferred to v1.1 (v1: account deletion keeps messages as "Deleted User") · T15 warn on system-audio capture, prefer per-app · T19 no persistent message cache in v1 · T20 uploads on main origin with sandbox CSP, separate files domain optional · T21 LiveKit host networking by default on Linux · T22 single app node in v1.

### Deferred to M0 spikes (evidence decides)
T1 Fastify vs Hono · T2 Kysely vs Drizzle · T3 TURN cert sharing · T11 "(verify)" facts · T12 speaking indicators under E2EE · T14 pop-out approach · T16 RNNoise tier · T18 electron-builder vs Forge.

### Chores before first public commit (not sign-off blockers)
F4 name/trademark check for "Tin Can" and slug `tincan` · F5 rename the project folder.

### Batch 3 review decisions (2026-10-27)
| Topic | Decision | Docs touched |
|---|---|---|
| Roadmap cut order | **Keep as written** in 17 §6 (Postgres/Redis are second in the cut order; note this means interchangeable DBs could slip to v1.1 under time pressure) | none |
| Desktop UI delivery | **Bundled renderer** confirmed | 13 §2 |
| Saved-servers switcher | **Included in v1**: simple saved list, one active connection at a time | 13 §6 |
| Push-to-talk | **No native global input hook in v1.** In-window hold-to-talk + global toggle-mute/deafen/leave shortcuts + CLI commands; native hold-to-talk deferred to v1.1 | 01 R-035, 03, 09 §10, 13 §4.2, 15, 17 |

| Primary install path | **Signed release bundle** is primary; the `curl \| sh` one-liner is a documented secondary that only fetches and verifies the same bundle | 14 §4 |
| TURN on 443 | **Optional advanced setup.** v1 default is TURN/TLS on 5349 + UDP 3478; 443 sharing via SNI router documented and tested in spike D6, not required. Consequence: friends on strict school/work networks may fail to connect; the in-app connection test (08 §10) tells them why | 14 §2.3 |

All items raised in the batch 3 walkthrough are now decided.

### Spec-gap fixes (self-audit, 2026-10-27)
Done: `password_reset` table, `POST /auth/reset`, and ephemeral OIDC state documented (06, 07, 11) · synced `user_setting` table, `/users/@me/settings` endpoints and `USER_SETTINGS_UPDATE` event, with a clear synced vs device-local split (06, 07, 12 §8) · OIDC reclassified as an auth adapter, not a module (04) · stale "open" text on E2EE persistence, UDP strategy, webhook exposure and CLI packaging corrected (02, 05, 06).
Pending your call: the product-feature candidates found in the audit (stream previews, sharer's viewer list, camera background blur, welcome/rules/announcements, upload quotas, GIFs/custom emoji/soundboard, separate stream volume).

### Feature candidates decided (2026-10-27)
| Candidate | Decision | Docs |
|---|---|---|
| Stream preview thumbnails | **v1.1** | 17 backlog |
| Viewer list for the sharer | **v1** (R-046; client-reported, best-effort, viewers notified) | 01, 08 §5.6, 12, 15 |
| Camera background blur / virtual backgrounds | **v1.1** | 17 backlog |
| Welcome / rules / announcements | **v1.1** (all of it) | 17 backlog |
| Upload quotas and disk warning | **v1** (R-021; `uploads.userQuotaBytes`, `diskWarnPercent`) | 01, 04, 06, 07, 12, 17 |
| GIF picker, custom emoji, soundboard | **None in v1** (GIF picker would also need an opt-in third-party provider) | 17 backlog |
| Separate stream-audio volume | **v1** (R-047) | 01, 08 §5.7, 12 |

### Remaining sign-off blockers
- You review docs 12–17 (batch 3) and any corrections to 07–11.
- Roadmap and cut lines (17 §6) accepted.
