# 17. Roadmap & Milestones

Sequencing the work so that something usable exists early, risk is retired
first, and scope can be cut without breaking the product. Estimates are relative
effort (S ≈ days, M ≈ 1–2 weeks, L ≈ 3–5 weeks, XL ≈ 6+ weeks) for one full-time
developer, with ±50% uncertainty; calendar time depends on availability. They
exist to compare milestones, not to promise dates.

## 1. Principles

1. **Retire the scariest unknowns first** (spikes), cheaply.
2. **Vertical slices:** each milestone ends with something people can use.
3. **Dogfood early:** put the friends group on it as soon as text + voice work (M3).
4. **Cut lines are decided in advance** (§6).
5. **Docs and tests ship with features** (16 §15), not after.

## 2. Milestone overview

```
 M0 Spikes ─▶ M1 Skeleton ─▶ M2 Text ─▶ M3 Voice ─▶ M4 Video ─▶ M5 Hardening ─▶ M6 Desktop ─▶ M7 Beta ─▶ v1.0
   (S–M)        (M)           (L)        (L)         (L)           (L)             (L)          (M)
```

| # | Milestone | Size | Outcome |
|---|---|---|---|
| M0 | Spikes & design closure | M | Risks D1–D6 answered; UI design sketches; docs updated with facts |
| M1 | Skeleton | M | Repo, CI, module loader, config, accounts, setup flow, web shell, compose stack |
| M2 | Text chat | L | Channels, messages, realtime, roles/permissions, invites, uploads, unread, search |
| M3 | Voice (web) | L | Voice channels, presence, audio pipeline v1, device settings, TURN, doctor |
| M4 | Video & screenshare (web) | L | Camera, screenshare presets, viewer opt-in, stream view, quality controls |
| M5 | Hardening & ops | L | E2EE, moderation, audit, backups, metrics, security review, load tests |
| M6 | Desktop (Electron) | L | Shell, keychain, source picker + system audio, global shortcuts, tray, installers, updater, signing/notarisation |
| M7 | Beta | M | Wider testers, bug burn-down, docs complete |
| v1.0 | Release | S | Tagged release, installers, images, announce |

Rough total: 5–8 months for one full-time developer (wide uncertainty); a
usable friends-group build (text + voice) at the end of M3 (≈ 2.5–4 months).

## 3. Milestone details

### M0. Spikes & design closure
**Goals:** replace "(verify)" guesses with measured facts; finalise open choices.
| Spike | Question | Exit criteria |
|---|---|---|
| D1 | LiveKit self-hosted behaviour: ports, config keys, dynacast flatness, egress per viewer; whether LiveKit refreshes tokens for connected participants itself (18 T25) | Config sketch in 08/14 corrected; measured numbers recorded |
| D2 | Denoiser worklet CPU/latency/quality; AEC vs Web Audio playback; model licence | Tier choice made (T16); numbers in 09 |
| D3 | Electron screenshare + audio on Windows/Linux/macOS/Wayland; `globalShortcut` behaviour per OS/Wayland (native PTT hook feasibility only as v1.1 input) | Support matrix written (13 §5) |
| D4 | E2EE + simulcast/SVC + speaker detection; LiveKit room SID and metadata as the E2EE session (T27); audio-level header under E2EE (T33) | Decision on defaults (T12, T17); T27 confirmed; T33 closed |
| D5 | Kysely vs Drizzle on better-sqlite3 + FTS5 (v1 is SQLite-only, T32): async transactions, event-loop blocking of backups and search (T28) | Pick + migration pattern (T2); blocking numbers recorded. **Done (2026-10-28):** Kysely; numbers in 18 §D D5 |
| D6 | TURN/TLS cert sharing with deferred LiveKit reload (T30); single-port UDP; host-network routing and the narrowed Caddy route (T26) | Final network docs (T3) |
Also: Fastify vs Hono (T1, **done**: Fastify), electron-builder vs Forge, **low-fi wireframes and a
token/style guide for the main screens (drafted by Claude, approved by you; done 2026-10-28,
`docs/design/`)**,
app icon/brand basics, repo creation and licence headers (`AGPL-3.0-or-later`
SPDX tags, DCO check in CI; F3 resolved).
**Deliverable:** updated docs 03/08/09/10/13/14, spike code kept in `spikes/`.

### M1. Skeleton
Monorepo (pnpm), TS configs, lint/format, CI PR pipeline, module loader + config
validation + `/capabilities`, DB port (Kysely on SQLite, with the D5 transaction guard and DB worker thread, 05 §3.1) + migrations framework,
accounts + sessions + setup flow, gateway skeleton (HELLO/IDENTIFY/READY/
heartbeat/resume), web shell (auth gate, layout, theme, i18n scaffold), Docker
compose with Caddy + app (+ LiveKit placeholder), `tincan init/doctor` v0.
**Exit:** you can deploy to a VPS, create the owner, log in on web, see an
empty layout; CI green; module boot matrix test exists.
**Status (2026-10-28): built and confirmed by you.** CI green on `main`. Demo checklist in [qa/m1.md](qa/m1.md); cuts and deferrals in 18 §H. First run on a real VPS (mkarl.io, Ubuntu + Docker, Let's Encrypt) done 2026-10-29; it found one bug (empty `email` in the generated Caddyfile), fixed in `a52a1d3`. Ports for voice (7881, UDP range, 5349) are still unopened and untested.

### M2. Text chat
Channels/categories, roles + permission engine + overwrites, invites + register,
messages (create/edit/delete/history/pagination/replies/mentions), realtime
delivery, unread/read-state, uploads + thumbnails + per-user quotas, member list + presence,
search (FTS5, fed by the core outbox), contract tests for the DB, storage and pubsub
ports (one adapter each in v1: SQLite, local, memory; 18 T32), markdown rendering,
notifications (web), admin panes (roles, channels, invites).
**Exit:** a text-only Tin Can is pleasant enough for a friends group to use
daily; authorisation matrix tests pass; the DB contract suite passes on SQLite.
**Status (2026-10-29): built and confirmed by you.** Demo checklist in [qa/m2.md](qa/m2.md); what was cut and learned in 18 §I. Server side is covered by tests (authorisation matrix of 420 cases, search crash-recovery, upload and invite races).

### M3. Voice
LiveKit integration (explicit room creation, token minting, webhooks, presence
and permission reconciliation),
voice channels UI with sidebar presence, voice manager + device manager, audio
pipeline v1 (browser AEC + DeepFilterNet tier + fallback, presets, mic test,
PTT in-window), connectivity diagnostics, TURN configured,
`doctor` network checks, staging deployment. (The minimal Electron shell moved out, to its own milestone M6 Desktop, decided 2026-10-29.)
**Exit:** friends can talk in voice channels from the web client with good audio;
reconnect works; the 3-person media test passes in CI.
**This is the dogfooding start.**
**Status (2026-10-29): built, deployed on mkarl.io and confirmed by you.** Spikes D1, D4 and D6 run locally, D2 only partly (18 §D, §J). Web voice, the audio pipeline, the connection test, `doctor` network checks and the 3-person media test are in. **Electron shell: moved to its own milestone, M6 Desktop (your decision, 2026-10-29).** Fixed after your first real calls: right ear silent with RNNoise (`d8b5637`), per-person volume up to 300 % (`5f00fed`), local speaking ring (`dd77bc3`), "Back to text" removed (`ce11038`). Still open: TURN/TLS relay (needs a second DNS name and ports 5349/tcp and 3478/udp) and the test from a network that blocks UDP, a phone and other browsers, the spike D1 load numbers on the VPS, D4 on real hardware (closes T33). This is the dogfooding start.

### M4. Video and screenshare (web)
Camera + screenshare with presets, simulcast/dynacast, viewer opt-in/stream view,
quality controls, sharer viewer list, stream-audio volume (browser capture; screenshare
audio where the browser offers it), permission bits and token grants, upload
independence test in CI (G4). Desktop work moved to M6 (your decision, 2026-10-29).
**Exit:** camera and screenshare work end to end in the web client in current Chrome/Edge and Firefox; the media test covers publish and subscribe.
**Status (2026-10-29): built, not yet confirmed by you.** Camera, screen share, viewer opt-in, stream view, quality controls, the sharer's viewer list, stream-audio volume, the server caps and live revocation are in; the 3-person media test passes 22/22 in Chromium on fake devices, including the upload independence check (G4: 1290 kbps with one viewer, 1292 with two, 0 with none). **Not run:** Firefox, Safari, a real screen picker or camera, a phone, the VPS. Cuts and facts: 18 §K; walk-through: qa/m4.md.

### M5. Hardening & operations
Voice E2EE + rotation + UI, moderation (kick/ban/timeout/server-mute/move) and
audit log, backups/restore commands + CI test, metrics + dashboards profile,
rate-limit tuning, security review pass (15 §9), load/soak tests, a11y pass,
performance pass, upgrade/rollback rehearsal, docs (admin guide, user guide).
**Exit:** security checklist S-01…S-15 verified; restore tested; known gaps documented.

### M6. Desktop (Electron)
The minimal Electron shell (window, secure bridge, keychain, instance entry, Authorization header injection T31,
unsigned installers), desktop source picker + system audio per OS, global mute/deafen/leave shortcuts and CLI commands,
tray/badges/notifications/autostart, deep links, pop-out/PiP, auto-update,
signing + notarisation pipeline, Linux packaging, Wayland support work. Starts with spike D3.
**Exit:** the success criteria in 01 §8 are demonstrable end to end on all three OSes.

### M7. Beta
Invite a wider set of testers (other hosts, not only your friends), collect
issues, burn down P0/P1, finalise installers, release notes, website/README,
`SECURITY.md`, CONTRIBUTING (DCO), issue templates, example deployments for common providers.
**Exit:** ≥ 3 independent Hosts run it successfully; no open P0/P1.

### v1.0
Tag, publish images/installers/checksums/SBOM, announce.

## 4. Dependencies & critical path

```
M0 (D1,D6) ─▶ M3 voice networking
M0 (D2)    ─▶ M3 audio pipeline
M0 (D3)    ─▶ M6 desktop capture/PTT
M0 (D4)    ─▶ M5 E2EE
M1 skeleton ─▶ everything
M2 permissions ─▶ M3 token grants ─▶ M5 moderation
M3 voice ─▶ M4 video/screenshare ─▶ M5 E2EE ─▶ M6 desktop ─▶ M7 beta
```
Critical path: M0 → M1 → M2(permissions) → M3 → M4 → M5 → M6 → M7. Text chat polish items can
run parallel to voice work if a second contributor appears.

## 5. Staffing assumptions & parallelism

**Decided (18 §F):** you steer and review; Claude does most of the implementation,
milestone by milestone. Consequences for planning:
- Calendar pace is limited by **review and decision turnaround and hands-on testing**, not coding time. Sizes in §2 are best read as relative effort; expect them to compress for pure coding but not for platform testing (screenshare, PTT, audio on real hardware, signing), which needs you and your friends on real machines.
- Each milestone should end with a reviewable, runnable increment and a short demo checklist so reviews stay cheap.
- Work is still sequential per area; independent areas (server module vs client UI vs desktop shell) can be built in parallel sessions when their interfaces (07, 04) are frozen.
- Things only you can do: accounts and certificates (domain, VPS, Apple/Windows signing), hardware testing across OSes, listening tests for audio, choosing between options at the spikes, and recruiting beta Hosts.
UI/UX design: **Claude drafts low-fi wireframes and a token/style guide in M0; you approve before UI code starts.** Radix primitives plus a restrained design system.

## 6. Scope cut lines (decide now, not under pressure)

If time runs short, cut in this order (last first):
1. Reactions, link previews, search UI polish (modules can ship disabled).
2. ~~Postgres adapter and Redis pubsub~~ Already out of v1 (18 T32).
3. ~~S3 storage adapter~~ Already out of v1 (18 T32).
4. OIDC.
5. Pop-out windows (keep PiP).
6. macOS system audio, Linux Flatpak.
7. E2EE (the module is optional by design; ship in v1.1).
**Not cuttable for v1:** accounts/invites, roles/permissions, text chat, voice with
good audio, screenshare, desktop installers for the three OSes, backups, security
basics, docs.

## 7. v1.1 and beyond (backlog)

| Item | Notes |
|---|---|
| TOTP 2FA, passkeys | 11 §1.8 |
| Postgres, Redis pub/sub and S3 adapters | 18 T32; the ports and contract tests are already in v1 |
| Account data export | 11, 15 §6 |
| Email adapter (verification, reset, digests) | optional |
| Threads, DMs/group DMs, custom emoji | Q2/Q3 reversals |
| Recording module (non-E2EE channels) | 08 §12 |
| Multiple simultaneous instance connections | 13 §6 |
| Native denoiser via utility process, auto-level | 09 |
| Native global hold-to-talk hook (opt-in) | 13 §4.2.3 |
| Stream preview thumbnails in the sidebar | 08, 12 |
| Chat beside a stream (split view) | design U3; v1 uses pop-out / picture-in-picture |
| Camera background blur / virtual backgrounds | 08, 09 |
| Welcome message, rules screen, announcements | 11, 12 |
| Custom emoji, GIF picker (needs opt-in provider), soundboard | 12 |
| Web Push notifications | 12 |
| Public plugin/bot API (webhooks, bot tokens) | 04 §12 |
| MLS-based E2EE where Host can't read keys | 10 §9 |
| Native mobile apps | Q10 |
| Federation/multi-space UI | ADR-015 |
| Admin UI for module toggles | Q8 |
| Kubernetes/Helm | 14 §10 |
| Auto-moderation, reports | 15 §7 |

## 8. Risks to the schedule

| Risk | Effect | Mitigation |
|---|---|---|
| Screen capture / PTT platform quirks (K-05, K-06) | M6 overruns | Spike D3 early; ship documented limitations |
| Audio quality tuning is open-ended | M3 slips | Time-box: ship default presets, tune later via settings |
| Code-signing/notarisation setup friction (K-14) | M6/M7 delays | Start accounts/certs in M1; unsigned dev builds meanwhile |
| Scope creep from modularity | Everything | Follow cut lines; module interfaces only when two implementations exist |
| Single-developer burnout (K-16) | Stall | Dogfood milestone M3, small wins, publish progress |
| Upstream changes in LiveKit/Electron | Rework | Pin versions; schedule dependency-upgrade windows between milestones |

## 9. Release & versioning policy

- Semantic versioning for the product; `apiVersion` integer separate (07 §6).
- Release cadence after 1.0: monthly minor (features), patch releases for fixes/security as needed; security fixes out-of-band.
- LTS: none initially.
- Changelog in Keep-a-Changelog format; migration and breaking-change notes mandatory.
- Support policy: latest minor + previous minor for security fixes.

## 10. Documentation deliverables (tracked like features)

| Doc | Audience | Milestone |
|---|---|---|
| README, quickstart | Hosts | M1 |
| Admin guide (install, ports, DNS, backups, upgrade, troubleshooting) | Hosts | M3→M5 |
| User guide (join, audio setup, screenshare, PTT per OS) | Members | M4 |
| Architecture docs (this set, kept current) | Contributors | continuous |
| Operations runbook, security guide | Hosts | M5 |
| API reference (OpenAPI) | Contributors | M2 |
| CONTRIBUTING, code of conduct, SECURITY.md | Community | M7 |

## 11. Sign-off checklist for starting M0

- [x] Docs 00–18 reviewed; open questions in 18 §A resolved (done) and technical open items triaged (2026-10-28; decisions in 18 §F)
- [x] Roadmap and cut lines accepted (2026-10-28)
- [x] Decided who is building: you plus Claude doing most coding (§5); dates depend on your review cadence, to be set when M0 starts
- [ ] Name/trademark check done (F4)
- [x] Repo location & hosting chosen (GitHub: `GoranSalzmann/TinCan`), licence headers decided (F3: `AGPL-3.0-or-later` + DCO)

## Open items
- Calendar dates (need your availability).
- Whether to hire/commission UI design.
- Whether beta testers beyond the friends group exist.
- Budget for signing certificates and a staging VPS.
