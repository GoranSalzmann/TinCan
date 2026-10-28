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
| T1 | ~~Fastify vs Hono final pick~~ **Decided (2026-10-28): Fastify**, on spike T1's evidence. It validates and strips responses at runtime (Hono sent an internal field and a schema-breaking body unchecked), enforces the 64 KiB gateway frame cap (Hono's WS adapter cannot set one), and served validated POSTs 1.9× faster; Hono is lighter (10 vs 70 packages). Evidence in 03 ADR-005 | 02, 03, 05 |
| T2 | ~~Kysely vs Drizzle final pick (SQLite only in v1, T32)~~ **Decided (2026-10-28): Kysely**, on spike D5's evidence. Its async transactions serialise correctly on one better-sqlite3 connection; Drizzle's better-sqlite3 transactions are synchronous only, and an async callback type-checks but loses atomicity (silently in 1.0.0-rc.5). Evidence in 03 ADR-007 | 02, 03, 05, 06 |
| T3 | Cert sharing Caddy ↔ LiveKit TURN/TLS. **Proposed (14 §2.3):** shared read-only cert volume, TURN/TLS on 5349; TURN on 443 via SNI router is an optional advanced setup; confirm in D6. **Decided (T30):** LiveKit reload deferred until no rooms are active | 03, 14 |
| T4 | ~~UDP strategy~~ **Resolved (08 §3.2):** single UDP mux port 7882 + TCP 7881 + TURN/TLS; confirm in spike D6 | 02, 08, 14 |
| T5 | ~~Webhook exposure~~ **Resolved (14 §2.1):** `/api/internal/*` blocked at Caddy; LiveKit calls the app over the internal Docker network. **Reasoning reopened by T26:** with LiveKit on host networking (T21) there is no shared Docker network | 05, 14 |
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
| T23 | UI/UX design (wireframes, design tokens, brand, icon). **Wireframes and style guide approved 2026-10-28:** screens W-01 to W-55, the style guide and design calls U1–U16 in `docs/design/` (§F); the calls are applied to 06, 07, 12 and 17. **Still open:** brand basics and the app icon (17 §3 M0) | 12, 17, design/ |
| T24 | Calendar dates and weekly time budget to turn sizes in 17 into a schedule | 17 |
| T25 | **Decided (§F): accepted.** Review blocker (K-29). Make the presence reconciler also reconcile permissions: each pass, recompute CONNECT/SPEAK/VIDEO/SCREEN_SHARE for every LiveKit participant from the DB; `removeParticipant`/`updateParticipant` on mismatch; rotate the E2EE key if anyone was removed. Failure-path enforcement becomes ≤ 30 s (the 2 s SLO still holds on the happy path) | 05 §6.3, 10 §4.3, 11 §2.6 |
| T26 | **Decided (§F): accepted.** Review blocker (K-30). Rework default compose routing for LiveKit host networking: publish the app on `127.0.0.1:3000` and point the webhook there; reach LiveKit via `host-gateway`; bind LiveKit's HTTP port 7880 to loopback; restate T5's reasoning. Narrow the Caddy route `/livekit/*` to the signalling path (`/livekit/rtc*`) so LiveKit's Twirp RoomService API is not proxied publicly | 05, 14 §2.1–2.2, 15 §4.7 |
| T27 | **Decided (§F): LiveKit room SID + room metadata; confirm in D4.** Move E2EE room-session state out of app memory so a restart re-derives the same key: salt = LiveKit room SID (create the room explicitly on first join), epoch in room metadata; or persist `(channelId, salt, epoch)` in the DB. Stop `keyIndex` restarting at 0 across sessions (K-31) | 06 §3.13, 10 §4.1 |
| T28 | **Decided (§F): accepted.** SQLite on the event loop: incremental `.backup()` for scheduled **and** pre-migration backups (no `VACUUM INTO`, no file copy); replace full `VACUUM` with `PRAGMA optimize` + `incremental_vacuum`; bound FTS query cost; decide whether the DB moves to a worker thread (K-32, K-36). **D5 result (2026-10-28):** no full move. One DB worker thread with its own read-only connection runs search and scheduled snapshots; snapshots use `VACUUM INTO` there, because `.backup()` stalls the main thread and never finishes from a second connection under writes. No `PRAGMA optimize`/`ANALYZE` on the live loop; maintenance runs in small steps on the main thread (05 §3.1, §D D5) | 05 §3.1, §7, 06 §7–8, 14 §7 |
| T29 | **Decided (§F): accepted.** Derived data: compute mention counts from `message_mention` after `last_read` instead of keeping a counter; make ack `max(existing, new)`; index search from an in-transaction outbox row (core-provided, so module boundaries hold) plus a `tincan search reindex` command; add the crash window to the SearchIndex contract tests (K-33) | 04 §6, 06 §3.8–3.9, 07 §3.6, 16 §3 |
| T30 | **Decided (§F): keep TURN/TLS on 5349 with a shared certificate; defer the LiveKit reload until no rooms are active, with a deadline before expiry. Caddy layer4 not adopted.** TURN/TLS termination: Caddy layer4 (SNI) terminates TLS and LiveKit TURN runs with `external_tls`, removing cert sharing and the renewal restart, and making TURN on 443 the default on one IP. Cost: a custom Caddy build. Fallback: defer the LiveKit reload until no rooms are active, with a deadline before expiry. Reopens T3 and the §F "TURN on 443 optional" decision (K-34, K-01) | 03 ADR-014, 14 §2.3 |
| T31 | **Decided (§F): Electron header injection.** Desktop file access: Electron `webRequest.onBeforeSendHeaders` injects `Authorization` for the instance origin (plus the origin in the desktop CSP `img-src`), or the local storage adapter mints HMAC-signed expiring URLs with bucketed expiry so `signedUrl` never returns null (K-35) | 05 §3.2, 07 §3.7, 13 §3, 15 §5 |
| T32 | **Decided (§F): v1 ships SQLite, local storage and in-memory pub/sub only; Postgres, Redis and S3 adapters are post-v1.** Decide now whether v1 ships one adapter per port (SQLite, local, memory; port interfaces and contract tests kept), rather than building Postgres/Redis in M2 and cutting them in M5 after paying the portability cost. Cost: a later move off SQLite needs a data-migration tool, not a config flip (K-09) | 01 R-063, 02 §5, 17 §6 |
| T33 | If D4 confirms speaker detection survives E2EE via the RTP audio-level header extension: close K-18, drop the client-shared-levels fallback, and add "who is speaking, and when" to the metadata E2EE does not protect (K-11) | 10 §2, §6 |
| T34 | **Decided (§F): accepted.** Observability at the seams: emit `reconcile_repairs_total{kind}` and alert on a sustained non-zero rate (a reconciler silently masks a broken primary path, as in K-30); carry the request ID into bus events and handler logs | 05 §8, 14 §8 |

## C. Risk register

Likelihood (L) and impact (I): H/M/L.

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| K-01 | Users cannot connect media because of UDP/NAT/firewall issues | H | H | Built-in TURN/TLS on 5349 + TURN/UDP 3478 (TURN on 443 stays an optional advanced setup, §F and T30), connectivity-check page in the client, clear Host docs, startup self-test |
| K-02 | Server bandwidth exhausted by screenshare fan-out | M | H | Documented sizing; per-channel bitrate cap; simulcast + adaptive stream; low-upload and viewer-quality controls; warn Host in docs about metered VPS |
| K-03 | Dependency on LiveKit (breaking changes, licence change, abandonment) | L | H | Pin versions, track releases, keep LiveKit calls inside few modules; accept lock-in knowingly (ADR-002) |
| K-04 | Neural denoiser costs too much CPU on low-end machines or has glitches | M | M | Auto-fallback to RNNoise/browser NS; presets; off switch; benchmark in CI on reference hardware |
| K-05 | Wayland (Linux) screen capture and global hotkeys behave differently | H | M | Test matrix includes GNOME/KDE on Wayland; PipeWire portal path; X11 fallback; document limits |
| K-06 | macOS system-audio capture during screenshare unsupported or needs extra permissions/driver | H | M | Declare as known limitation; offer window/app capture without audio; investigate ScreenCaptureKit-based path in Electron |
| K-07 | Electron security misconfiguration | M | H | Hardened defaults, contextIsolation, sandbox, strict CSP, no remote code, review checklist (13, 15) |
| K-08 | SQLite write contention under busy chat | L | M | WAL, single writer queue, batch ops; Postgres escape hatch is post-v1 (T32) |
| K-09 | Dual-DB support doubles testing/bugs | L | M | Resolved for v1 by T32 (SQLite only). Returns when the Postgres adapter is built; its SearchIndex consistency differs from SQLite's (K-33) |
| K-10 | Webhook loss → wrong presence | M | M | Idempotent handlers + reconciliation job + client-side tolerance |
| K-11 | E2EE gives false sense of security (Host controls key distribution) | M | M | Document threat model plainly (10); no overclaiming in UI |
| K-12 | Scope creep from "extremely modular" ambitions | H | M | Bounded modularity (ADR-003/004), no plugin API in v1, build order in 17 |
| K-13 | Abuse on public instances (spam, illegal uploads) | L | H | Invite-only default, rate limits, upload limits, moderation tools; legal notes in Host docs |
| K-14 | Auto-update/signing costs (Apple notarisation, Windows code signing) | H | M | Budget for certificates; unsigned dev builds documented; evaluate SignPath/free OSS options |
| K-15 | Browser codec/feature differences (AV1, screen audio) | M | L | Capability detection, codec preference list with VP8/H.264 fallback |
| K-16 | Single developer bus factor / burnout | M | H | Prioritised milestones, finish voice+text first, defer extras |
| K-17 | Routing remote audio through Web Audio (volume boost >100%) degrades echo cancellation | M | M | Keep playback on media elements by default; boost flagged as headphones-only; validate in spike D2 (09 §7) |
| K-18 | LiveKit server-side active-speaker detection unavailable under E2EE, hurting speaking indicators | H | M | Client-computed levels shared via gateway/participant attributes; validate in spike D4 (10 §6). Possibly not a real risk: detection may read the RTP audio-level header extension, which frame encryption leaves in clear (D4, T33) |
| K-19 | Several facts about LiveKit/DeepFilterNet in 08–10 come from memory, not the pinned versions | M | M | Mark as "(verify)", spike D1/D2/D4 before treating as fact; update docs after spikes |
| K-20 | No global hold-to-talk in v1 (and no global shortcuts on some Wayland sessions); gamers may want it | H | M | Decided (18 §F): in-window PTT + global toggle-mute/deafen/leave + `tincan --toggle-mute` CLI; native hook is a v1.1 option (13 §4.2) |
| K-21 | Fresh instance exposed before setup could be claimed by a stranger | L | H | One-time setup token printed to server logs/file (11 §1.4) |
| K-22 | Home hosts behind CGNAT cannot receive media connections | M | M | `doctor` detection, VPS recommendation, relay/tunnel docs (14 §1) |
| K-23 | ~~macOS Input Monitoring friction~~ Removed from v1 by the no-native-hook decision; returns only if the v1.1 hook is built | L | L | 13 §4.2.3 |
| K-24 | GPU/driver bugs cause black video or crashes in Electron | M | M | Hardware-accel toggle, auto safe-mode after repeated GPU crashes (13 §7) |
| K-25 | Electron/Chromium security patches require fast desktop releases | H | M | Automated dependency PRs, release checklist, auto-updater (13 §11, 15 §9) |
| K-26 | Bundled renderer can fall out of sync with newer servers | M | M | `apiVersion` negotiation, update prompts, additive-change policy (07 §6, 13 §2) |
| K-27 | Unpolished product: the approved low-fi design still has to be built well | M | M | Wireframes and style guide approved 2026-10-28 (`docs/design/`, T23); restrained design system (17 §5); tokens and the contrast check become code and tests in M1; visual regression on key screens (16) |
| K-28 | Test infrastructure (media, multi-OS) is costly to build and may flake | M | M | Layered strategy, manual matrix as backstop, quarantine policy (16) |
| K-29 | A ban, kick or permission loss fails to remove the user from a live voice call: enforcement is a single fire-and-forget bus handler calling LiveKit (04 §6), nothing retries, and the reconciler checks presence, not permission. The user keeps the current E2EE key | M | H | T25 (reconcile permissions every pass); D1 checks whether token refresh is a backstop at all |
| K-30 | Default compose topology doesn't route: with LiveKit on host networking (T21) it cannot resolve `tincan`, and Caddy/app cannot resolve `livekit`. Webhook failure is masked by the 30 s reconciler, so it looks like presence lag | H | H | T26; T34 (count reconciler repairs) |
| K-31 | With E2EE on by default and the in-memory kv, every app restart (config change, upgrade, crash) loses room session and epoch and forces an unnecessary rekey. Late joiners get a key existing participants lack, and `keyIndex` restarts at 0, colliding with the old key. Seconds to tens of seconds of silence in every encrypted call, contradicting "app restart doesn't drop calls" (02 §3, 14 §7) | H | M | T27; D4 |
| K-32 | better-sqlite3 runs every query on the main thread: the weekly `VACUUM` and `VACUUM INTO` backups on a multi-GB DB (≈8.5 GB/year with FTS as measured in D5, 06 §9) freeze HTTP and the gateway; past ~50 s every client reconnects at once. "N read connections" add no concurrency on one thread | M | M | T28; measured in D5 (`VACUUM INTO` 45 s, first `ANALYZE` 19–34 s, unbounded search ranking up to 4.5 s on 4 GB): search and snapshots on a DB worker thread, step-wise maintenance (05 §3.1) |
| K-33 | The SQLite search index and `read_state.mention_count` are updated by bus handlers after commit; a crash or `SQLITE_BUSY` in that window leaves permanent drift and nothing rebuilds them. Postgres `tsvector` is in-transaction, so the adapters differ and the SearchIndex contract tests miss it. A stale device's ack can move `last_read_message_id` backwards | M | M | T29 |
| K-34 | TURN/TLS certificate renewal reloads (restarts) LiveKit (14 §2.3), dropping every call roughly every 60 days at a time chosen by ACME | H | M | T30 (decided: reload deferred until no rooms are active, so the restart lands in an empty moment); D6 |
| K-35 | Desktop renderer (`app://`, bearer token) cannot load `/files/*` through `<img>`: no header, and no cookie cross-site. Avatars (R-006) and inline images return 401 in the primary client | H | M | T31 |
| K-36 | Pre-migration backup is a plain file copy (06 §8, 14 §7); after an unclean stop it misses committed transactions still in the WAL, so an upgrade rollback loses recent data | L | M | T28 |
| K-37 | A search cannot be cancelled once running: better-sqlite3 has no `interrupt()` or progress handler. A query shape that escapes the bounds in 05 §3.1 holds the DB worker for seconds (D5: 43 s for an UNINDEXED channel filter), queuing every other search behind it | L | M | Bounded query shapes (05 §3.1), search only on the DB worker, per-user search rate limit; add the worst shapes to the event-loop perf test (16) |

## D. Assumptions to validate early (spike list)

Referenced elsewhere as D1 to D6.

- **D1.** LiveKit self-hosted on a cheap VPS: measure CPU/egress for 1 publisher at 1080p30 → 5 viewers; confirm dynacast keeps publisher upload flat as viewers increase; verify (08) config values.
  - *Design review (§G):* does LiveKit itself refresh tokens for connected participants, so the app is never asked again? If so, "the app re-checks permissions on token refresh" (05 §6.2, 08 §4.4, 15 §4.4) is not a revocation backstop (K-29, T25).
- **D2.** DeepFilterNet WASM worklet: CPU and latency on a low-end laptop; quality vs RNNoise vs browser NS on recorded samples; AEC behaviour with Web Audio playback (K-17); model licence check.
- **D3.** Electron `desktopCapturer` with audio on Windows/Linux; behaviour on Wayland and macOS.
- **D4.** LiveKit E2EE + simulcast + dynacast (+ VP9/AV1 SVC) working together; active-speaker approach under E2EE (K-18).
  - *Design review (§G):* room SID semantics (a new SID per room instance after `emptyTimeout`), creating the room before minting the token, server-set room metadata for the epoch, and keyring index behaviour across sessions (K-31, T27). Whether active-speaker detection reads the RTP audio-level header extension, which frame encryption leaves in clear (K-18, T33).
- **D5.** Query-builder tooling (Kysely/Drizzle) on better-sqlite3 with FTS5. v1 is SQLite-only (T32), so dual-dialect migrations are no longer in scope.
  - *Design review (§G):* the Db port's async `transaction(fn)` must work on better-sqlite3 for the chosen builder (Kysely serialises through a mutex; Drizzle's better-sqlite3 transactions are reportedly synchronous only, confirm). Measure main-thread blocking for `VACUUM INTO`, `.backup()` and FTS queries on a ~4 GB fixture (K-32, T28).
  - *Result (2026-10-28), done.* Code in `spikes/d5-db/`, raw numbers in its `RESULTS.md`. Measured in Docker on a Ryzen 5800X with NVMe, capped at 2 CPUs and 2 GB; a cheap VPS will be slower, so rerun `src/bench/blocking.ts` there before quoting absolute numbers.
    - **Transactions.** Kysely 0.29.7 passes every concurrency scenario once two fixes from the spike are in: `begin immediate`, and a guard so the root handle cannot be used inside a transaction (it deadlocks otherwise). Drizzle's better-sqlite3 transactions are confirmed synchronous only (0.45.4 and 1.0.0-rc.5). → T2 decided: Kysely.
    - **Typed queries and migrations.** Both builders give typed queries with no codegen. Kysely migrations are plain TS objects and a small runner; Drizzle needs `drizzle-kit generate` on every schema change and a custom file for FTS5.
    - **Outbox → FTS5.** The prototype caught up after a kill between commit and indexing. It survived redelivery and eight random kills under load. `search reindex` rebuilt a damaged index online (≈ 9 min for 3.4M messages).
    - **Main-thread blocking (4 GB fixture: 3.38M messages, 4.00 GB).**
      - Fine in small steps: `incremental_vacuum(1000)` 46 ms; FTS5 `'merge', 100` 9 ms; retention deletes, 500 per batch, 64 ms; newest-first search ≤ 25 ms.
      - Not fine on the main thread: `VACUUM INTO` 45 s; first `PRAGMA optimize`/`ANALYZE` 19–34 s; FTS5 `'optimize'` 9 s; unbounded `ORDER BY rank` up to 4.5 s; `.backup()` stalls of 0.4–2.8 s.
      - `.backup()` from any connection but the writer's never completes under 100 writes/s.
      - `VACUUM INTO` on a worker thread finished in 40 s with main-thread writes at p99 4.1 ms. → T28: one DB worker thread for search and snapshots (05 §3.1).
    - **Schema findings.**
      - 06 §3.9 keys FTS rows by an UNINDEXED `message_id`, which costs 0.5 s per edit or delete; the fix is a `message_id → rowid` map owned by `search`.
      - Filtering by the UNINDEXED `channel_id` took 43 s for a channel with no hits; the fix is an indexed channel column in FTS5 (1 ms).
      - FTS5's own copy of the text is 1.26 GB of the 4 GB. An external-content or contentless table would avoid that copy; not measured.
    - **Docs updated to match (2026-10-28).**
      - 06 §3.9: `search_doc` map, channel and author as indexed FTS5 columns, query bounds.
      - 06 §7–8, 05 §7 `backup.hook`, 14 §6–7: snapshots via `VACUUM INTO` on their own connection (DB worker, or the CLI process), fsynced and renamed. The boot-time pre-migration backup may block.
      - 05 §7 `db.maintenance`: no `PRAGMA optimize`; `incremental_vacuum` and FTS5 `merge` in steps.
      - 16 §3 and §9: transaction-isolation contract tests; the search shapes from 05 §3.1 in the event-loop test.
      - 17 M0: D5 and T1 done.
- **D6.** TURN/TLS on 443 sharing a port/cert with Caddy (T3, T4); single-port UDP mux behaviour.
  - *Design review (§G):* whether LiveKit can reload TURN certificates without a restart (expected: no), and that the deferred reload sees active rooms correctly through `ListRooms` (K-34, T30). Loopback/`host-gateway` routing with LiveKit on host networking, `bind_addresses`, and LiveKit's signalling path prefix for narrowing the Caddy route (K-30, T26).

## E. Sign-off checklist

- [x] Q1–Q10 answered
- [x] All docs 00–17 written (drafts complete)
- [x] All docs 00–17 reviewed by you (signed off 2026-10-28, after the design review in §G)
- [ ] Spikes D1–D6 scheduled (not necessarily done). D5 started 2026-10-28; the others need dates (T24) and your VPS and test machines
- [x] Roadmap (17) accepted (2026-10-28, with the cut lines as amended by T32)
- [x] Licence and name chosen (AGPL-3.0, Tin Can)

## F. Sign-off triage outcome (2026-10-27)

### Decided by you
| Ref | Decision | Effect on docs |
|---|---|---|
| T17 | **E2EE is on by default** for new installs and new voice channels (Hosts can turn it off globally or per channel). Browsers lacking the needed APIs are refused on `required` channels. | 10, 04 (config default `voice.e2ee: true`), 14 (`tincan init` default) |
| F3 | **AGPL-3.0-or-later** (SPDX `AGPL-3.0-or-later`) with **DCO** sign-off for contributors. No CLA; commercial relicensing would need every contributor's consent. | 03 ADR-018 |
| T23 | **Claude drafts low-fi wireframes and a token/style guide in M0**; you approve before UI code starts. | 17 M0 |
| T24 | **You plus Claude doing most of the coding.** You steer and review; implementation proceeds milestone by milestone. Pace depends on your review time, not coding time. | 17 §5 |
| T1 | **Fastify** as the HTTP framework (2026-10-28, after spike T1). | 02, 03 ADR-005, 05 |
| T2 | **Kysely** on better-sqlite3 as the query builder (2026-10-28, after spike D5). | 02, 03 ADR-007, 05, 06 |

### Accepted recommendations
T10 typing events gateway-only · T13 2FA/export/deletion semantics deferred to v1.1 (v1: account deletion keeps messages as "Deleted User") · T15 warn on system-audio capture, prefer per-app · T19 no persistent message cache in v1 · T20 uploads on main origin with sandbox CSP, separate files domain optional · T21 LiveKit host networking by default on Linux · T22 single app node in v1.

### Deferred to M0 spikes (evidence decides)
T1 Fastify vs Hono · T2 Kysely vs Drizzle · T3 TURN cert sharing · T11 "(verify)" facts · T12 speaking indicators under E2EE · T14 pop-out approach · T16 RNNoise tier · T18 electron-builder vs Forge.
Spike results so far (2026-10-28): D5 is done (§D). On its evidence and spike T1's you decided **T1 Fastify** and **T2 Kysely** (03 ADR-005, ADR-007), which unblocks M1's DB port and HTTP layer.

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

### Design review decisions (2026-10-27)
| Ref | Decision | Docs touched |
|---|---|---|
| T25 | **Accepted.** The voice reconciler also re-checks permissions every pass; failure-path enforcement ≤ 30 s | 02, 04, 05, 08, 10, 11, 15, 16, 17 |
| T26 | **Accepted.** Loopback/host-gateway routing for host-networked LiveKit; port 7880 off the public interface; Caddy proxies only `/livekit/rtc*` | 14, 15, 17 |
| T27 | **LiveKit room SID + room metadata** carry the E2EE session, so app restarts need no rekey (confirm in D4) | 02, 05, 06, 08, 10, 16, 17 |
| T28 | **Accepted.** Incremental `.backup()` for scheduled and pre-migration backups; no full `VACUUM`; bounded search. Revised after D5 (2026-10-28): snapshots via `VACUUM INTO` on their own connection, search on a DB worker thread (05 §3.1) | 03, 05, 06, 14, 16, 17 |
| T29 | **Accepted.** Computed mention counts, monotonic acks, search fed by a core outbox, `tincan search reindex` | 04, 05, 06, 07, 16, 17 |
| T30 | **Keep 5349, defer the reload.** Shared Caddy certificate; LiveKit restarts only when no rooms are active, or near expiry. Caddy layer4 not adopted; TURN on 443 stays optional | 03, 14, 17 |
| T31 | **Electron header injection** for `/files/*` and other subresources | 05, 07, 13, 15 |
| T32 | **v1 ships SQLite, local storage and in-memory pub/sub.** Ports and contract tests stay; Postgres, Redis and S3 adapters are post-v1 | 00, 01, 02, 03, 04, 05, 06, 07, 14, 16, 17 |
| T34 | **Accepted.** `reconcile_repairs_total` with an alert; request IDs carried through the bus | 04, 05, 14 |

Still open: T33 (waits for spike D4).

### UI design calls (2026-10-28)
| Ref | Decision | Docs touched |
|---|---|---|
| U1–U16 | **All approved as drafted** (docs/design/README.md): mute and deafen in the user panel; joining voice keeps your text channel; no chat-beside-stream split in v1 (backlog); focus ring separate from the accent; no instance rail on the web; accent from checked presets; role colours never colour names; member list docks at ≥ 1280 px; settings as a full-screen layer; Lucide icons; system fonts only; `role.hoist`; join voice at once; no badges for unconnected servers; one-time watching notice; own-attachments list and delete for Storage. The screens (W-01 to W-55) and the style guide were approved the same day with no changes (T23) | 06, 07, 12, 17, design/ |

### Remaining sign-off blockers
None. You signed off on 2026-10-28: docs 00–18 reviewed, roadmap and cut lines accepted. Spike dates (T24) are still to be set; they don't block starting M0.

## G. Design review findings (2026-10-27)

A blocks-and-"-ilities" review of docs 01–17. Each finding maps to a risk (§C),
an open item (§B) and, where it rests on unverified LiveKit or library
behaviour, a spike (§D). Those claims are not facts until the spike confirms them.

| Severity | Finding | Risk | Open item | Spike |
|---|---|---|---|---|
| Blocker | Removing someone from live voice relies on one fire-and-forget handler | K-29 | T25 | D1 |
| Blocker | Default compose routing broken by LiveKit host networking | K-30 | T26 | D6 |
| Risk | App restart forces an E2EE rekey in every encrypted call | K-31 | T27 | D4 |
| Risk | Synchronous SQLite blocks the event loop; WAL-unsafe pre-migration copy | K-32, K-36 | T28 | D5 |
| Risk | Search index and mention counts drift with no repair | K-33 | T29 | — |
| Risk | Certificate renewal restarts LiveKit; K-01 mitigation was stale (corrected) | K-34, K-01 | T30 | D6 |
| Risk | Desktop can't load authenticated files | K-35 | T31 | — |
| Polish | Dual-DB portability paid for before it's needed | K-09 | T32 | — |
| Polish | K-18 may not be real; speaking activity missing from E2EE metadata list | K-18 | T33 | D4 |
| Polish | Reconciler repairs uncounted; no correlation IDs across the bus | — | T34 | — |

-ility ratings: reliability **gap**; availability, security, latency (text),
consistency, maintainability and observability **at-risk**; durability **holds**
once T28 lands. Set aside as not load-bearing at this scale: scalability, cost,
testability.

Decisions on these findings are recorded in §F, and docs 00–08, 10, 11 and 13–17
now reflect them (the M0 spike table in 17 §3 carries the §D additions). T33
stays open until spike D4.
