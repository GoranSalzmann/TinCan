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
| T33 | If D4 confirms speaker detection survives E2EE via the RTP audio-level header extension: close K-18, drop the client-shared-levels fallback, and add "who is speaking, and when" to the metadata E2EE does not protect (K-11) **Closed (D4, 2026-10-29, §J D4-2): confirmed.** | 10 §2, §6 |
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
| K-18 | LiveKit server-side active-speaker detection unavailable under E2EE, hurting speaking indicators | H | M | Client-computed levels shared via gateway/participant attributes; validate in spike D4 (10 §6). Possibly not a real risk: detection may read the RTP audio-level header extension, which frame encryption leaves in clear (D4, T33) **Resolved by D4 (2026-10-29): not a risk.** |
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
  - *Result (2026-10-29), done locally; VPS numbers outstanding.* LiveKit refreshes tokens itself (the app is not a revocation backstop); dynacast keeps publisher upload flat (1.57 / 1.55 / 1.51 Mbps for 1 / 3 / 5 viewers); SFU CPU about 3 to 4 % of a core. Details in §J D1-1 to D1-6.
- **D2.** DeepFilterNet WASM worklet: CPU and latency on a low-end laptop; quality vs RNNoise vs browser NS on recorded samples; AEC behaviour with Web Audio playback (K-17); model licence check.
  - *Result (2026-10-29), partly done.* The DeepFilterNet npm package fetches its model from a third-party CDN, so it is not shippable; RNNoise and GTCRN are self-contained. T16: ship RNNoise plus the browser fallback. CPU, latency, quality and AEC with Web Audio playback (K-17) are **not measured**: they need a real device and ears. §J D2-1 to D2-3.
- **D3.** Electron `desktopCapturer` with audio on Windows/Linux; behaviour on Wayland and macOS.
- **D4.** LiveKit E2EE + simulcast + dynacast (+ VP9/AV1 SVC) working together; active-speaker approach under E2EE (K-18).
  - *Design review (§G):* room SID semantics (a new SID per room instance after `emptyTimeout`), creating the room before minting the token, server-set room metadata for the epoch, and keyring index behaviour across sessions (K-31, T27). Whether active-speaker detection reads the RTP audio-level header extension, which frame encryption leaves in clear (K-18, T33).
  - *Result (2026-10-29), done for VP8.* E2EE, 3-layer simulcast and dynacast work together; the server's active-speaker events are the same with and without E2EE (**T33 closed, K-18 is not a risk**); the room SID and metadata are stable and shared (**T27 confirmed**). VP9/AV1 SVC and keyring index behaviour across sessions were not tested. §J D4-1 to D4-4.
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
  - *Result (2026-10-29), partly done.* `bind_addresses` binds only the HTTP port; single-port UDP works; certificates are read at start only (T30 confirmed). **Not done:** TURN reachability and TURN/TLS on a real host, and the Caddy route against a host-networked LiveKit, need the VPS. §J D6-1 to D6-4.

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

Still open: nothing. T33 was closed by spike D4 on 2026-10-29 (§J).

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

## H. M1 build notes (2026-10-28)

Facts learned while building the skeleton, and what was cut. Detail sits in the docs named.

| Ref | Note | Doc |
|---|---|---|
| M1-1 | `TINCAN_CONFIG` shares the env prefix with settings. First compose run failed with `unknown setting "config"`. It is now ignored by the override logic, and the host uid/gid use `HOST_UID`/`HOST_GID` for the same reason. Lesson: control variables must not start with `TINCAN_` | 04 §9, 14 |
| M1-2 | A stale `*.tsbuildinfo` copied into a Docker build makes `tsc -b` skip emit, so the web build could not find `@tincan/shared`. `.dockerignore` excludes them | 14 |
| M1-3 | Web session = HttpOnly cookie + `X-Tincan-CSRF` header + single-use gateway ticket (a script cannot read the cookie to put a token in `IDENTIFY`) | 07, 11 §1.2 |
| M1-4 | `ws` can answer 1009 to an oversize frame while the client sees the connection reset (1006) first; tests accept both | 07 §4.7 |
| M1-5 | Kysely does not close a `better-sqlite3` handle it never opened a connection on; `Db.close()` closes the raw handle too (a leak showed as EPERM on Windows temp-dir cleanup) | 05 §3.1 |
| M1-6 | TypeScript is pinned to 6.0.x because typescript-eslint supports `<6.1`; revisit when it supports 7 (the spikes used 7.0) | 16 |
| M1-7 | LiveKit image is unpinned in the generated compose (profile `voice`); pin in D1 before M3 (K-03) | 14 §2 |
| M1-8 | Web bundle is ~515 kB: the shared zod schemas ship to the browser | 12 |

**Cut or deferred from M1 (by design, to the milestone named):** roles, channels, default `#general`/`Lounge` and `@everyone` (M2); invites, `/auth/register`, password reset codes, user settings sync, avatars (M2); OIDC (cut line 4); `search` helper and outbox drain job (M2, with `search`); OpenAPI output (M2, 17 §10); voice checks in `doctor` and the setup checklist (M3); Playwright e2e (nightly pipeline, 16 §12); `packages/ui` (tokens stay in `apps/web`); mobile drawer is minimal and the member list overlay below 1280 px is basic; the Electron shell (out of scope).

## I. M2 build notes (2026-10-29)

Facts learned while building text chat, and what was cut. Detail sits in the docs named.

| Ref | Note | Doc |
|---|---|---|
| M2-1 | Serving a stored file with an explicit `Content-Length` and a stream made the server hang on shutdown in a test (`app.close()` never finished, with no request in flight); without the header (chunked) it closes at once. Cause not found; the header is left off. Downloads therefore show no total size while they run (the message already carries the size). Worth a second look before large files matter | 07 §3.7 |
| M2-2 | better-sqlite3 refused `?1`-style numbered parameters bound from an array ("too many parameter values"); the search SQL uses plain `?` and passes a value twice where needed | 05 §3.1 |
| M2-3 | `PUT /channels/:id/overwrites/:type/:targetId` replaces that target's allow/deny pair; it does not merge. The admin UI always sends the full pair. A test that "added an @everyone overwrite" silently removed the `VIEW_CHANNEL` deny on a private channel, which is what the authorisation matrix now guards against by using a scratch role | 07 §3.4 |
| M2-4 | A hidden channel answers 404 on every route (not 403), so the existence of a private channel does not leak; the matrix checks that the error body is only the envelope and that the error for a hidden channel equals the one for a missing channel | 15, 16 §5 |
| M2-5 | The permission engine caps what an overwrite can do: only the channel-scoped bits (0–14) apply, so a stored or sent `ADMINISTRATOR`/`MANAGE_ROLES` in an overwrite is inert | 11 §2.3 |
| M2-6 | The outbox needed a way to resume after a restart that the harness could not fake with one process; the search crash test stops delivery (`outbox.close()`), sends, closes the server and boots a second one on the same data directory. A row that fails five times is dropped (logged), so one bad payload cannot stall search for everyone; `search reindex` repairs | 05 §3.1 |
| M2-7 | Reindex goes through the outbox, reading inside the same transaction that queues (so a concurrent edit is queued before or after, never behind stale text), then queues removals for index entries whose message is gone. Not measured at the 3.4M-message scale of D5 | 06 §3.9 |
| M2-8 | TanStack Virtual's own scroll adjustment on row-size change fights a live-edge follower (the newest message ended up 25 px below the fold); the list turns it off, anchors prepends itself and keeps the bottom pinned for 500 ms after a new row. Found by hand in the browser, not by a test | 12 §5.3 |
| M2-9 | In React Router 7 `useParams` in a layout cannot see the child route's params, and `navigate()` may return a promise (lint). The settings layer reads `/settings/:section/:id?` with `useMatch` | 12 |
| M2-10 | `sharp` installs from prebuilt binaries (no build step); the licence scan passes. Thumbnails and avatars are WebP | 05 §1 |

**Calls I made that you may want to change:** history without `READ_HISTORY` returns an empty list but live events still arrive (11 §2.2 leaves it open) · a text channel's default notification level is "all messages" until a member picks one · Admin does not hold `ADMINISTRATOR` (as in 11 §2.2), so an Admin cannot see a private channel unless an overwrite allows the Admin role; the owner always can · `@here` is treated like `@everyone` (no per-presence targeting) · role positions are contiguous and a role cannot be created or moved to or above the editor's own rank · the web client lists voice channels but does not join them (M3) · the invite link is `/invite/<code>` on the web origin.

**Cut or deferred from M2 (to where it goes):** reactions and link previews (cut line 1; the modules stay out of the build) · moderation (kick, ban, timeout, server mute) and the audit log (M5; the permission bits, `authorizeAction` rules and a timeout path in `roles` exist and are tested) · OpenAPI output (17 §10) · `GET /search` `before`/`after` filters · `Range` requests on files · message retention and account deletion jobs · "mark as unread", emoji picker, quick switcher, shortcut list and the other screens listed as "not drawn yet" in `docs/design/README.md` · right-click menus (channel actions are in a **…** menu) and drag reordering (Move up/down instead) · a roving-tabindex tree for the channel list (plain links today) · a Playwright end-to-end test (16 §12) · `INSTANCE_UPDATE`, `MEMBER_REMOVE` and `SESSION_REPLACED` events · `appearance.density` is accepted as a setting but no UI uses it yet · moderators seeing "Message deleted by …" (W-03) · "Open in app" on the invite page (desktop, M3/M4) · the web client has only been exercised in one browser at one window size.

**Done 2026-10-29:** first run on a real VPS with a domain (mkarl.io) and a Let's Encrypt certificate; you walked the M1 and M2 checklists there and confirmed. It found one bug: `tincan init` without `--email` wrote an empty `email` line that Caddy rejects (fixed in `a52a1d3`, with a test). **Still open:** voice ports on the host firewall (7881, UDP media range, 5349), a phone and other browsers, and a longer trial with real friends. One DB contract test failed once and passed on re-runs; watch for it (`packages/db/src/contract.ts`).

## J. M3 build notes (2026-10-29)

Spike results for D1, D2, D4 and D6 (raw output in `spikes/m3-voice/`), what they changed, and what M3 cut or left to you. Measured in Docker Desktop on a Ryzen 7 5800X; **not on the VPS**, so the absolute numbers are a floor. LiveKit **v1.13.10** (pinned in the generated compose file), livekit-client 2.23.0, Chromium 148 with fake devices.

### Spike results

| Ref | Result | Changes |
|---|---|---|
| D1-1 | **LiveKit refreshes tokens for connected participants itself.** A `refreshToken` message arrives at join and again after every `updateParticipant`; the refreshed token carries the *current* permissions (publish revoked → `canPublish:false`). The app is never asked. A token is only checked at connect and reconnect. | T25 stands: an app-side re-check on refresh is not a backstop, the reconciler is. Join tokens live 10 min (`voice.tokenTtlSecs`). 08 §4.4, 05 §6.2 |
| D1-2 | `createRoom` is idempotent: a second call returns the same SID and keeps the metadata. After `empty_timeout` the room is deleted (`room_finished` webhook about 20 s after the last leave with `empty_timeout: 20`) and the next `createRoom` gives a **new SID**. | T27 confirmed (D4-3) |
| D1-3 | A client that never completes WebRTC gets `participant_connection_aborted`, not `participant_left`. Webhook workers run in parallel, so events can be duplicated, late or reordered. | The presence store handles both names and has ordering rules (event id, session SID, tombstones) |
| D1-4 | **Dynacast works and publisher upload is flat in the number of viewers.** 1080p30 simulcast (1080p and 540p, fake source): publisher upload 1.57 Mbps with 1 viewer, 1.55 with 3, 1.51 with 5; each viewer received about 1.07 Mbps. With no viewer both layers were inactive. With adaptive stream and 320 px tiles the 1080p layer stopped and upload fell to 0.46 Mbps. | G4 holds; 08 §5.1 confirmed |
| D1-5 | LiveKit CPU: about 3 to 4 % of one core for 1 publisher at 1080p and 5 viewers (about 5.5 Mbps out), 2-CPU cap, browsers on the same machine. The fake video is low-complexity, so the bitrate stayed far under the 3.5 Mbps cap. | Rerun on the VPS with real content before quoting capacity (08 §13) |
| D1-6 | Config keys verified against v1.13.10: `rtc.tcp_port`, `rtc.udp_port` (one port is a mux; the server logs `portUDP {Start:7882,End:0}`), `rtc.use_external_ip`, `rtc.node_ip`, `room.empty_timeout`, `room.departure_timeout`, `turn.*`, `webhook.api_key/urls`, `bind_addresses`, `prometheus.port` (`prometheus_port` is deprecated). `canPublishSources: []` in a grant means **all sources**, so the app sends `canPublish:false` for a listener. | 14 §2.2 corrected; `grantFor` |
| D4-1 | **E2EE, 3-layer simulcast and dynacast work together** (VP8). Receivers with the key decode 720p; a late joiner with the key decodes; a client with the wrong key receives bytes but decodes no frames; replacing the key on both ends keeps media flowing, replacing it on the sender only stops decoding at the receiver. VP9/AV1 SVC was **not** tested. | Defaults T12/T17 can stay as drafted for VP8; SVC stays open (10, 08 §5.3) |
| D4-2 | **Active-speaker detection survives E2EE.** The server sent `ActiveSpeakersChanged` for an E2EE publisher exactly as without E2EE (it reads the RTP audio-level extension, which frame encryption leaves in the clear). **T33 is closed and K-18 is not a risk: drop the client-shared-levels fallback; "who is speaking, and when" joins the metadata E2EE does not protect (K-11).** `participant.audioLevel` read 0 on the client in both runs at the sampling instant, so it is not a usable source. | 10 §2, §6; T33, K-18, K-11 |
| D4-3 | **T27 confirmed.** The room SID and the room metadata are in the join response and identical for every participant; a late joiner derives the same key from secret and SID with no help from the app. The epoch in room metadata survives an app restart (the room lives in LiveKit). A SID changes only after the room was empty past `empty_timeout`, which is when a new key is wanted anyway. Not built here (E2EE is M5). | 10 §4.1 |
| D4-4 | Audio bitrate on the wire: 77 kbps without E2EE, 48 kbps with it, same Opus settings (DTX and RED requested). Consistent with RED being switched off under E2EE; not proven. | Capacity numbers for E2EE rooms use 48 kbps (08 §5.5) |
| D6-1 | **`bind_addresses` restricts only the HTTP port.** With `[127.0.0.1]`, 7880 is closed from another container but open on loopback; 7881 (ICE/TCP) and 5349 (TURN/TLS) stay open on all interfaces. With `[127.0.0.1, <gateway>]` both work. | T26 confirmed. The generated file binds loopback and the Docker host gateway (`172.17.0.1`; `--host-gateway-ip` changes it) |
| D6-2 | **Single-port UDP mux works** (every client in D1 and D4 used 7882/udp). The TURN relay range defaults to 30000–40000/udp; clients that relay to the SFU on the same host should not need it open (to be confirmed on the VPS). | T4: one UDP rule (7882/udp), plus 7881/tcp and 5349/tcp |
| D6-3 | **TURN certificates are read at start only.** Replacing the files did nothing; `SIGHUP` stopped the container; `docker restart` served the new certificate. `ListRooms` is available for the "no active room" check. | T30 confirmed. `tincan voice turn-reload` (below) |
| D6-4 | With UDP blocked in the browser's network namespace, the client connected over ICE/TCP 7881. Relay-only did **not** connect in the Docker bridge emulation: a relay candidate was allocated but the SFU's checks to it went unanswered. | **Not conclusive about TURN.** Needs the real test on the VPS (Settings → Voice & audio → Test connection, from a network that blocks UDP) |
| D2-1 | DeepFilterNet: the only npm package (`deepfilternet3-noise-filter`, Apache-2.0 OR MIT) is a loader that fetches the WASM and the model from `cdn.mezon.ai` at run time. That is a third-party host in the audio path with nothing to hash. A self-hosted DeepFilterNet needs a reproducible build of upstream with the model weights (licence of the weights still to be confirmed). | **Tier A is not shipped in M3.** The pipeline has the tier slot; the work is a WASM build in the repository |
| D2-2 | RNNoise (BSD-3 via `@sapphi-red/web-noise-suppressor`, MIT, 152 kB WASM plus a 157 kB SIMD variant) and GTCRN (a small neural denoiser, 197 kB) ship inside that package and can be self-hosted. | **T16: ship RNNoise (tier B) as the default, browser noise suppression (C) as the fallback, Off (D).** GTCRN is a candidate for tier A, unevaluated |
| D2-3 | **Not measured:** CPU and latency of the denoisers (offline rendering produced silence; a live context does not start without an audio device) and quality on recorded speech. | Needs your ears and a real machine: docs/qa/m3.md |

### Facts learned while building

| Ref | Note | Doc |
|---|---|---|
| M3-1 | The webhook path is `/api/v1/internal/livekit/webhook`: module routes live under `/api/v1`. Caddy now answers 404 for `/api/internal/*` **and** `/api/v1/internal/*` (the old rule alone would have left it open). `tincan doctor` checks both ends. | 05 §6, 14 §2.1 |
| M3-2 | The Caddy CSP needs `'wasm-unsafe-eval'` in `script-src` or RNNoise cannot compile (the pipeline then falls back to the browser's suppression and says so). Not yet seen behind a real Caddy. | 14 §2.1 |
| M3-3 | A zustand selector that returns a fresh `[]` loops forever (React error 185). The unit tests rendered no voice component; the media test caught it in a real browser. Component tests for the call view, dock and rows were added. | 12 |
| M3-4 | **Existing bug fixed:** the web gateway client answered a `RECONNECT` op with `close(1001)`, which browsers refuse (`InvalidAccessError`), so the socket stayed open. Found by restarting the app mid-call. It now closes with 1000. | 07 §4 |
| M3-5 | The server sends `VOICE_SERVER_DISCONNECT` *before* it removes the person from LiveKit, and the client waits 1.5 s for it after a LiveKit "removed", so the reason shown is ours ("You no longer have permission"), not LiveKit's generic one. | 07 §5 |
| M3-6 | `voice` is on by default exactly when a `livekit:` section exists (`enabledByDefault` on the manifest); `modules.voice.enabled: false` turns it off. `livekit.apiUrl` (default `http://127.0.0.1:7880`) is where the server reaches the API; the generated `.env` points the container at `host.docker.internal:7880`, and the CLI on the host maps that name to loopback. | 04, 14 |
| M3-7 | An instance deployed before M3 (mkarl.io) has no `TINCAN_LIVEKIT__API_URL` in `.env` and no `extra_hosts` on the `tincan` service. After updating the image the voice module turns on, finds nothing at `127.0.0.1:7880` inside the container, logs one warning and answers joins with `UNAVAILABLE`. The runbook lists the edits. | docs/qa/m3.md |
| M3-8 | The media test runs 11 checks (join, Opus audio with loss under 5 %, server presence, mute, deafen, app restart mid-call, a 3 s network drop, SPEAK revoked and restored, CONNECT revoked, leave, no unexpected reconciler repairs) in about 45 s. On Windows, host Chrome could not connect to a LiveKit published through Docker Desktop (ICE failed), so the local runner puts everything in one network namespace (`tools/media-test/docker.sh`); CI uses host networking. | 16 §6 |

### Built

The `voice` module (rooms, tokens from permissions, signed webhook, presence, reconciler with repair counters at `GET /voice/status`, a private room for the connection test) and the channel settings `userLimit`, `bitrateKbps`, `videoAllowed`, `screenshareAllowed`; doctor voice checks and `tincan voice turn-reload`; a pinned LiveKit image, HTTP bound to loopback, optional TURN/TLS in `tincan init`; the web voice UI (sidebar presence, dock, call view, Voice & audio settings, connection test); audio pipeline v1 (browser AEC always on except Studio, RNNoise with a CPU guard and fallback, gate, gain, presets, mic test with A/B, push to talk in the window, per-person volume); the 3-person media test with a CI workflow; 34 server tests (grant table, hidden channel, limits, webhook races, reconciler repairs, fast path within 2 s) and 19 web tests.

### Cut or deferred from M3

| What | Where it goes |
|---|---|
| **Electron shell** (window, secure bridge, keychain, instance entry) | **Not built. Decided 2026-10-29: its own milestone, M6 (Desktop), after hardening.** D3 moves with it. |
| Installers (unsigned), global shortcuts | M6, with Electron |
| Camera, screenshare, viewer opt-in, stream audio volume, the sharer's viewer list | M4. Grants already include `camera` and `screen_share*`, and the channel switches exist |
| E2EE (key service, rotation, UI) and the epoch in room metadata | M5. T27 is confirmed; nothing is stored yet |
| Server mute, move, kick from voice | M5 (moderation). The permission bits and the `VOICE_SERVER_DISCONNECT` reasons exist |
| Tier A denoiser (DeepFilterNet class) | Needs a self-built WASM and a weights-licence check, or an evaluation of GTCRN |
| Noise-suppression strength slider, CPU and latency readout in settings, keybinds page, sensitivity meter with a threshold marker | Next UI pass |
| Output-device switching through `setSinkId` | Implemented, checked by type only; browsers without it show a note |
| Prometheus metrics for voice | The counters are at `GET /voice/status` and in `VoiceApi.stats()`; the `metrics` module exports them in M5 |
| A TURN test that blocks UDP in a network namespace (16 §6) | Needs a Linux CI runner with iptables; the emulation here was inconclusive (D6-4) |

### What I need from you (VPS, firewall, people)

See the runbook in [qa/m3.md](qa/m3.md). In short: open **7881/tcp and 7882/udp** (and **5349/tcp and 3478/udp** if you want the relay) in the provider's firewall and the host's; add a second DNS name if you want TURN; update and restart; walk the checklist with another person on another network.

## K. M4 build notes (2026-10-29)

Camera and screen share in the web client. Measured in Docker Desktop on a Ryzen 7 5800X with LiveKit **v1.13.10**, livekit-client 2.23.0 and Chromium 148 on fake devices; **not on the VPS, not in Firefox or Safari**. Decisions in §F and §J were not changed. Electron, the desktop source picker, global shortcuts, tray, installers and Wayland stay in M6.

### Facts learned while building

| Ref | Note | Doc |
|---|---|---|
| M4-1 | **Existing bug fixed (M3 code):** LiveKit's `UpdateParticipant` replaces the whole permission. `permissionMessage` did not send `canUpdateMetadata`, so after the first fast-path or reconciler update a client lost the right to set its own attributes (the "watching" list, 08 §5.6, depends on it). Now sent as `true`; the join token already had it. Nothing in M3 used attributes, so it went unnoticed. | 08 §5.6, §8 |
| M4-2 | **Dynacast stops an unwanted layer a few seconds after the last request for it**, not at once. A fixed measuring window right after watching saw the top layer still flowing for part of it (377 kbps) while `outbound-rtp.active` was already `false`. The media test waits for `active === false` and then measures. | 16 §6 |
| M4-3 | **Receive size: the client reports it, `adaptiveStream` stays off.** In livekit-client, `setVideoQuality` and `setVideoDimensions` replace each other and there is no public way back to the automatic mode once a quality was set. "Auto" is therefore `setVideoDimensions` from the drawn tile size (a `ResizeObserver`, times the device pixel ratio); High and Low use `setVideoQuality`; Pause video uses `setEnabled(false)`. A 374×209 tile received the 640×360 layer; High received 1280×720; Auto went back. | 08 §4.1, §5.4 |
| M4-4 | **A camera or share is not stopped by an unpublish** because the room option `stopLocalTrackOnUnpublish: false` (needed so the microphone can be republished) applies to every source. When the server takes VIDEO or SCREEN_SHARE away, LiveKit unpublishes and the camera light would stay on. The client stops those tracks itself on `LocalTrackUnpublished`. | 12 |
| M4-5 | **Grants and source numbers.** On the wire the client sees `canPublishSources` as numbers: camera 1, microphone 2, screen share 3, screen-share audio 4. An empty list with `canPublish` means all. The control bar follows `ParticipantPermissionsChanged`, so a revoked camera disables its button and a restored permission enables it without rejoining. | 08 §8 |
| M4-6 | **Opt-in is enforced by not subscribing.** `autoSubscribe` is off, video and screen-share audio are subscribed only after Watch, and the test asserts no inbound video RTP before it. "Watch" outside the call joins first. A camera that is switched off and on keeps the viewer's choice; a screen share that ends clears it, so the next share is a new opt-in. Deafen and undeafen only bring back stream audio of streams that are watched. | 08 §4.2 |
| M4-7 | **Viewer list.** A viewer sets the participant attribute `watching` to a comma separated list of stream keys (`userId:camera`, `userId:screen`) when it opts in or out; every client recomputes the map from all participants' attributes and the sharer's bar shows its own. Anyone in the room can read everyone's list (it is metadata, not secret), and a modified client can lie or stay unlisted. The viewer is told once per device (U15). | 08 §5.6 |
| M4-8 | **Stream audio** is a separate chain per sharer (`userId:screen`) with its own gain, the same limiter above 100 % and its own mute, stored in the same per-browser volume table. Published stereo with DTX and RED off at up to 96 kbps (08 §6). The voice of the same person is untouched (tested: changing the stream volume leaves `volumeOf(user)` at 1 and the voice level non-zero). The stereo and limiter behaviour of `d8b5637` and `5f00fed` is unchanged. The wire bitrate of stream audio was **not** measured. | 08 §5.7, §6 |
| M4-9 | **Screen share audio per browser (from the browsers' documentation, not tested here).** Chrome and Edge: tab audio on every OS, system audio only on Windows and ChromeOS for a whole screen; no audio for a window. Firefox: no audio capture in `getDisplayMedia`. Safari: none. The dialog says to share a tab and tick the browser's audio option; there is no per-browser detection, because the API cannot tell beforehand. `suppressLocalAudioPlayback` is requested so that a shared tab does not play twice. | 08 §6, qa/m4.md §E |
| M4-10 | **The media test cannot drive the browser's screen picker.** `getDisplayMedia` is replaced by an animated canvas (real motion, hence real bitrate) and, when audio is asked for, the fake microphone as "tab audio". Everything after the picker is the real path. Whether Chrome's real picker, `contentHint`, `surfaceSwitching` and `suppressLocalAudioPlayback` behave is for a person to see (qa/m4.md §D). | 16 §6 |
| M4-11 | `MEDIA_SKIP=<regex>` skips media-test steps by name (passed through `docker.sh`), so the video steps run in about 2 minutes while working on them. | 16 §6 |

### Spike D1 follow-up (publisher upload against viewers)

Run inside the media test, so it now runs in CI on every video change. One publisher with a simulcast 720p30 camera (720/360/180, cap 1.7 Mbps), fake source, both viewers asking for the top layer:

| Viewers | Publisher upload |
|---|---|
| 1 | 1290 kbps |
| 2 | 1292 kbps |
| 0 | 0 kbps (every layer inactive after about 8 s) |

The test fails if upload with two viewers exceeds 1.3 × the upload with one, or if the upload with none stays above 25 %. The M3 numbers (1, 3, 5 viewers of a 1080p source) are in §J D1-4. **Not done, needs more than this machine:** more than two viewers of a camera (the media test has three people), real content and real CPU on the VPS, throttled uplinks (simulcast under loss), and the egress of N real viewers against the provider's port. qa/m4.md §B and §F list the rows.

### Built

Server: `publishDefaults.video` with the camera and screen caps; the module config `voice.camera.maxBitrateKbps` (default 1700) and `voice.screenshare.maxBitrateKbps` (default 6000); the channel setting `maxScreenshareKbps` (300 to 60 000 since the custom-quality change, lowers but never raises the server cap); `canUpdateMetadata` kept on permission updates; 7 new server tests (caps, config, each bit its own sources, camera revoked by the fast path, screen switch off and on mid-call, camera and screen revoked by the reconciler after a failed fast path with a single counted repair, track presence for people who can see the channel). The grants, channel switches, webhook track presence and the 30 s reconciler re-check were already in M3 and are unchanged.

Web: camera (device, Low/Standard/High, simulcast and dynacast, mirrored self-view, device change in place, republish for a preset change); screen share (dialog with the three presets limited by the server cap, content hint, audio request, live change of quality and hint, sharing bar with the viewer list and an upload estimate); tiles in the call view with the speaking ring, one tab stop with arrow keys, watched screens first; opt-in with Watch on tiles; stream view in focus and grid layouts with volume (0 to 300 %), mute, Auto/High/Low/Pause video, picture in picture, fullscreen, Stop watching; one-time watching notice; auto-watch cameras (off by default); a camera section in the voice settings; unit and component tests for the presets, caps, stream keys, viewer list, tile order and keyboard movement; media test with 11 new steps including G4.

### Cut or deferred from M4

| What | Where it goes |
|---|---|
| Electron source picker, system audio per OS, pop-out window, global shortcuts, tray, Wayland | M6, unchanged |
| Pop-out (W-17) is the browser's picture in picture only; the Document PiP / window decision (T14) | M6, with D3 |
| A limit on how many people may share at once in a channel | Not built. LiveKit cannot unpublish a track except by revoking the source, which the reconciler would then undo within 30 s. The Host's levers are `screenshareAllowed` and the bitrate caps |
| Bitrate caps are advisory | LiveKit cannot enforce a publisher's bitrate; a modified client can exceed them. Egress is bounded by the number of viewers the Host lets in |
| Admin screen for the channel's video switches and `maxScreenshareKbps` | API only (`PATCH /channels/:id`); the channel settings pane has none of the voice settings yet |
| "Stats for nerds", a quality menu on camera tiles, the stream view for cameras | Cameras have Watch and Stop watching on the tile; the stream view is for screens. Resolution is shown in the stream view header |
| Changing "Share audio" while live | Needs a new capture; stop and start again (the dialog says so) |
| Stream previews, background blur | v1.1 (§F) |
| Simulcast under throttling, UDP-blocked video, more than three people in the media test | Needs a Linux CI runner with `tc`/`iptables` (16 §6) |
| E2EE for video | M5 |
| Firefox, Safari, phones | Untested; qa/m4.md lists the rows |

### What I need from you

See [qa/m4.md](qa/m4.md). In short: update the VPS like for M3 (no new ports); open a call with a second person and walk sections C to E with a real camera and a real screen picker in Chrome or Edge and in Firefox; say what you see for screen share audio on your OS; run the D1 numbers on the VPS if you want capacity figures.

### K2. Custom resolution, frame rate and bitrate (M4 follow-up, 2026-10-29)

Requested by you after M4 was merged: independent resolution and frame rate up to 4K, with the presets kept. Same environment as above; nothing here ran on a real 4K display, a real camera above 720p, Firefox or the VPS.

| Ref | Note | Doc |
|---|---|---|
| M4-12 | **Ceilings raised, defaults unchanged.** Screen share cap 20 → **60 Mbit/s**, camera cap 8 → **25 Mbit/s**, in the module config, `VideoLimitsPatchSchema`, the channel setting `maxScreenshareKbps`, the Settings → Server → Video quality card (range message, input bounds) and the channel dialog. Defaults stay 6 and 1.7 Mbit/s. | 08 §5.2, §9 |
| M4-13 | **Custom = resolution (360p to 2160p, 16:9), frame rate (5, 10, 15, 24, 30, 60), bitrate (Auto or a value).** A preset fills the controls, editing a control switches to Custom, the custom values are kept for later. Stored per browser in the same key `tincan.video.prefs.v1`, with two new fields; a stored value from an older version or a hand edit that is not on the lists is replaced by the default, so no key bump was needed. | 12, 08 §5.2 |
| M4-14 | **Auto bitrate is a formula, not a table:** about 0.06 bit per pixel at 30 fps times `(30/fps)^0.3`, rounded to 50 kbit/s, which lands within 5 % of every preset (720p30 camera 1.65 against 1.7, 1080p30 3.75 against 3.5, 1080p60 6.05 against 6.0, 720p15 1.0 against 1.0). 4K30 wants 14.95 Mbit/s and 4K60 24.2 before the codec factor. The factor (VP9 0.75, AV1 0.65 of VP8) is a rule of thumb, **not measured** here. | 08 §5.2 |
| M4-15 | **Codec decision.** Presets and custom up to 1080p30 stay on **VP8 simulcast** (every browser decodes it; nothing changes for existing users). Above that, **VP9 as one scalable encoding** (`L3T3_KEY`, the SDK default) is used when `RTCRtpSender.getCapabilities` lists it, and **AV1 only when `MediaCapabilities.encodingInfo` says the machine encodes it in hardware** (software AV1 at 4K would stall the computer, and the API cannot tell software from hardware any other way). The SDK's default backup policy publishes a VP8 stream when a viewer cannot decode the primary codec, so a viewer on an old browser still sees something at a lower quality, at the price of extra upload only while such a viewer is present. Why: at 1440p and 4K or 60 fps VP8 needs roughly a third more bitrate for the same picture and its software encoder is the first to run out of CPU. | 08 §5.3 |
| M4-16 | **Consequences of a scalable codec.** Simulcast layer lists have no effect on VP9/AV1 (the SDK ignores them), so the upload estimate for these is the top bitrate alone; for VP8 it is the sum of the layers. The SDK forces `contentHint: motion` for a screen share with an SVC codec (`livekit-client` publish path), so the "Text and detail" choice does nothing for those shares; the dialog still shows it. A running share cannot change codec: "Change" moves resolution, rate, bitrate and hint, not the codec; a camera is republished. | 08 §5.3 |
| M4-17 | **Honesty readout.** The sharing bar shows, per source, what was asked for (size, rate, bitrate, codec), what the browser captures (`MediaStreamTrack.getSettings`) and what the encoder sends (`getSenderStats`, top layer), every 2 s. It adds "Your browser delivers less than asked for" when the capture is under 95 % of the height or 80 % of the rate, and "limited by your processor/connection" from `qualityLimitationReason`. With nobody watching, dynacast sends nothing and the bar says so instead of showing 0×0. Chromium's fake camera delivers 1280×720 at most, which the media test uses to prove the message. | 08 §5.2 |
| M4-18 | **Caps are shown plainly.** If the cap is under 90 % of what the setting wants the dialog says "Capped to X Mbit/s by the server or channel, expect blockiness" and offers the highest resolution that fits at the same frame rate (or says nothing fits at that rate). A value typed below 90 % of Auto says it is below the usual figure. The cap in use is the lower of the server's and the channel's, as delivered by the join response, so a change applies from the next join. | 08 §5.2 |
| M4-19 | **Media test:** a custom 1080p60 share (VP9, readout, viewer receives 1920 wide), a custom 2160p15 share (captured, sent and received at 3840×2160 on the canvas shim, which now follows the requested size and rate), a custom 1440p30 camera (VP9, readout against a 720p fake camera) and the G4 check again with VP9 layers: **3030 kbps with one viewer, 3126 with two, 0 with none** (fake 720p source captured under a 1440p request, VP9 at the 5 Mbit/s the request wanted). The owner's caps are raised at the start of the run; presets sit far under them. | 16 §6 |

| M4-20 | **Existing bug fixed (M4 code):** `setCameraEnabled(false)` only mutes the track; turning the camera on again reused the old capture and encoding, so a changed preset (or resolution, rate, codec) never took effect and "republish" in the settings did nothing. Camera off is now a real unpublish that stops the track. The first custom-camera media step caught it (VP8 still on the wire while the bar said VP9). | 12 |

**Not tested:** a real 4K display or camera, hardware AV1, Firefox, Safari, a slow computer (the CPU limit message is untested), a viewer that cannot decode VP9 (the backup path), more than two viewers of a VP9 stream, and the real encoder load of 4K on the CI machine (the canvas is cheap compared with a real desktop). docs/qa/m4.md §G lists the rows.

## L. Runtime upload limits (2026-10-29)

The owner can change the largest file and the per-person upload space in **Settings › Server › Uploads**, with no restart (`GET/PATCH /admin/uploads`, owner only). The values are stored in the `upload_setting` table (uploads migration 2) and override `uploads.maxBytes` / `uploads.userQuotaBytes` from the config file, which stay the starting values. `/capabilities` reports the values in force, so the composer's own size check follows without a reload.

- **Ceiling.** One file is capped at 512 MiB whatever is set, (M5 made uploads stream and the ceiling is now **4 GiB**, a sanity bound kept below the backup archive's 8 GiB-per-file limit; the owner's own limit stays in Settings › Server › Uploads; see §M).
- **Lowering never deletes.** A smaller quota only blocks further uploads; existing files stay.
- **Proxy.** Caddy has no request-size limit in the generated Caddyfile, so nothing else needs changing for larger files.
- **Not covered by a test:** survival across a server restart (the test harness starts from an empty data directory). Checked by hand on mkarl.io on 2026-10-29: 500 MB saved in the settings, the app container restarted, `/capabilities` still reported 500 MB.

**Video caps and per-channel voice settings (same day).** Settings › Server › Video quality sets the server-wide camera and screen share top-layer caps (`GET/PATCH /admin/voice`, owner only, table `voice_setting`, voice migration 1); they apply to the next join, and a sharer already publishing keeps the bitrate they started with. The channel edit dialog now has the per-channel voice settings that existed only as JSON before: allow cameras, allow screen sharing, a screen share cap (can only lower the server's), most people at once and the voice quality cap. A blank field sends `null`, which clears the channel's own value so the server default applies again (channel settings merge on patch, and `null` removes a key). The caps stay advisory: LiveKit cannot enforce a publisher's bitrate, so a modified client could exceed them (08 §5.2).

## M. M5 build notes (2026-10-30)

Moderation and the audit log, voice E2EE, backup and restore, metrics and dashboards, the security review, load and soak scripts, the upgrade rehearsal, and the admin and user guides. Measured on Windows 11 / Docker Desktop (Ryzen 7 5800X), Node 26, LiveKit **v1.13.10**, livekit-client 2.23.0, Chromium 148 on fake devices; **not on the VPS, not in Firefox or Safari**. Decisions in §F were not changed; the choices M5 had to make are in the first table so you can overrule them. Checklist: [qa/m5.md](qa/m5.md); security result: [security/m5-review.md](security/m5-review.md); guides: [guides/admin-guide.md](guides/admin-guide.md), [guides/user-guide.md](guides/user-guide.md).

### Choices made while building (please confirm or overrule)

| Ref | Choice | Why | Doc |
|---|---|---|---|
| M5-1 | **Kick** signs the person out everywhere, removes them from voice and closes their sockets; they **can sign in again**. **Ban** does the same and refuses every later login (`BANNED`, the reason is shown) until lifted; an optional purge deletes their messages of the last 0–7 days. Both are by account, not by address. | An instance is one space with accounts; a kick that deleted the membership would leave an account that can log in and see nothing. | 11 §1.5, §3 |
| M5-2 | The **audit log** lives in the `moderation` module (table `audit_log`, `GET /audit-log` for `VIEW_AUDIT_LOG`). Moderation actions write their row directly. Other modules report on the bus (`audit.record`: role create/update/delete/assign, reset codes); that path is best effort and is lost if the process dies at that instant. | No module imports another; a durable write for the actions that matter, a cheap hook for the rest. | 06 §3.10 |
| M5-3 | An **encrypted room refuses a client that cannot encrypt** (`409`, `reason: e2ee_unsupported`): for `required`, and also for `inherit` while the server default is on. Doc 10 §3 said "encrypt when the client supports it" for `inherit`, which leaves a room where some people hear nothing. | A mixed room has no good state. S-15 holds for both. | 10 §3, §5 |
| M5-4 | The owner's switch **"Encrypt voice calls by default"** (Settings › Server, `GET/PATCH /admin/voice/e2ee`) is a runtime value in `voice_setting`; `modules.voice.e2ee.enabled` (default **true**, T17) is only the starting value. Changing it, or a channel's `e2ee` mode, closes an occupied room with `VOICE_SERVER_DISCONNECT {reason: "e2ee_mode_changed"}` and the web client rejoins by itself. | 10 §5. | 10 §5 |
| M5-5 | Key derivation: `roomKey = HKDF-SHA256(ikm = HMAC(instanceSecret, salt), salt = room SID, info = "tincan/e2ee/v1/<channel>/<epoch>")`. The **salt** is 32 random bytes in `voice_secret`, created on first use. `tincan e2ee rotate-secret` replaces the **salt**, not the instance secret; a running server notices within 30 s and rekeys every encrypted call. If the instance secret itself leaked, change it in `.env`. | Doc 10 §4.1 says "rotate the instance secret" but that secret also keys the IP hashes; a separate salt rotates the media keys without touching anything else. | 10 §4.1 |
| M5-6 | **Key index = epoch mod 16 is set explicitly** by a small subclass of `ExternalE2EEKeyProvider`. The stock `setKey()` always writes slot 0, which drops the previous key at the instant of a rotation and makes a late joiner's index disagree with everyone else's. | The keyring keeps the last keys so frames in flight still decrypt. | 10 §4.3 |
| M5-7 | Rotation: **at once** after a kick, ban, lost permission, a reconciler removal, or a moderator's move or disconnect; **lazily** after a voluntary leave (only if the last rotation is ≥ 5 min old); **every 6 h**; and after a new salt. Rotations are counted in `tincan_voice_e2ee_rotations_total`, **not** as reconciler repairs (they happen by design). | 10 §4.3. | 10 §4.3 |
| M5-8 | A person who joins another channel themselves is told `moved` (silent, as before); a **moderator's move** is `moved_by_moderator` with the destination, and the web client joins it. | The two need different client behaviour. | 07 §5 |
| M5-9 | **Backups are plain `.tar.gz`** (own ustar reader and writer, no archive library), with `manifest.json` last holding the SHA-256 of every entry. **Secrets are left out unless `--include-secrets`**; `config.yaml` always has its secret-looking values blanked in the default mode. `restore` goes into an **empty directory**, verifies every checksum and SQLite's integrity check, and only then moves anything into place. | 14 §6; the archive can be opened with any `tar`. | 14 §6 |
| M5-10 | **Metrics** use a small own registry (no dependency). `GET /api/v1/metrics` answers the scraper token (`modules.metrics.token`, generated by `tincan init`), the owner's session, or a connection that arrives **directly over loopback with no `X-Forwarded-For`**; behind Caddy none of the last applies, and Caddy answers 404 for the path anyway. The `dashboards` compose profile pins **Prometheus v3.5.0** and **Grafana 12.1.0**, publishes both on `127.0.0.1` only and runs them as the host user. | 14 §8. | 14 §8 |
| M5-11 | **API rate limits** (`security.rateLimit`): 600 reads and 120 writes a minute per member, 1200 calls a minute per address (webhook path exempt); at most **30 gateway sessions per member** (the oldest ends) and **60 sockets per address**. | S-11 had limits only on a few routes. | 15 §4.2 |
| M5-12 | **Uploads stream to storage** and share a memory budget for the one step that needs memory, decoding an image (`modules.uploads.memoryBudgetBytes`, default 384 MiB): an image that would go over it gets `429` with `Retry-After: 5`. It now guards only the image decode step; uploads themselves stream (see below). | The load test measured 1 to 2 times the file size per running upload (table below). | 18 §L |

### Facts learned while building

| Ref | Note | Doc |
|---|---|---|
| M5-F1 | **The whole media test passes with E2EE on (28 of 28 steps)** (it is the default now), including the parts D4 did not test: a **VP9 scalable** 1440p30 camera (upload 2183 kbit/s with one viewer, 2676 with two, 0 with none), a 1080p60 and a 2160p screen share, simulcast and dynacast (G4 flat), the app restart, the network drop and the SPEAK revocation. **AV1 under E2EE and Firefox/Safari are still untested.** | 10, 08 §5.3 |
| M5-F2 | A decrypt failure still delivers bytes, and `totalAudioEnergy` of the fake microphone did not move either way, so the media test measures **what reaches the playback tap** after decoding. Without that the "wrong key" case would pass. | 16 §6 |
| M5-F3 | After a removal the other participants get the new key within the same second in the test and keep hearing each other (media test: "the removal rotated the key …"). The gateway ring buffer may replay an old `E2EE_KEY_UPDATE` on a resume; the client ignores any key whose epoch is not newer. | 10 §4.3 |
| M5-F4 | **Existing bug fixed (M2 code):** `roles.setTimeout` set the timeout in memory only: it was lost on restart, never reached live voice sessions, and members were not told. It is now stored (`member.timeout_until`), emits `permissions.changed`, announces the member (`timeoutUntil` in `Member`) and expires by a job. | 11 §2.6 |
| M5-F5 | **Existing issue fixed:** the request log line carried the full URL, so an invite code in `GET /invites/<code>` reached the logs (S-12). URLs are now logged as route shape only. `X-Request-Id` is returned on every response and accepted when sent (T34). | 15 §6 |
| M5-F6 | During a join storm the **app-side user limit is soft**: 200 simultaneous joins to a room with limit 25 minted 110 tokens before the webhooks caught up, then refused the rest. LiveKit's `maxParticipants` (set at room creation) is what holds the limit at the SFU. | 08 §9 |
| M5-F7 | The current Playwright image's fake camera delivers what is asked (2560×1440 at about 20 fps here), where M4's notes say 1280×720. The media step now accepts both and demands the "less than asked" message exactly when the capture is short. | 16 §6 |
| M5-F8 | The pre-migration snapshot, the downgrade refusal and restore were **rehearsed with the real previous release** (`tools/upgrade-rehearsal`, 12 checks): see the admin guide. Snapshots are now pruned to the newest five. | 14 §7 |

### Load, soak and the upload ceiling (numbers)

Run with `pnpm load` (in process, fake LiveKit, Windows, Node 26). **The test client and the server share one Node thread**, so the latencies are pessimistic; a separate client process is a follow-up. They show the shape, not a capacity promise.

| Scenario | Result |
|---|---|
| 500 WebSockets, opened in waves of 50, held 20 s | all connected in 8.1 s, none dropped; READY p50 772 ms, p95 1170 ms; about 190 KiB of memory per socket (client side included); event-loop delay p99 464 ms |
| 20 senders → 500 listeners, 20 s | 41 messages/s sent, **20 450 deliveries/s**, 100.00 % delivered, send→receive p50 446 ms, p95 552 ms, p99 699 ms; event-loop delay p99 747 ms. **The weakest point is fan-out: one core is saturated by about 20 000 frames per second**, so a message costs time in proportion to the number of connected sockets |
| Voice join storm, 200 at once (app side) | 1.8 s for all; join call p50 323 ms, p95 657 ms; 5500 state updates reached 50 watchers; see M5-F6 |
| Uploads, before the budget (client streams, so the figure is the server's) | 25 MiB × 8: +379 MiB; 100 MiB × 4: +374 MiB; 256 MiB × 2: +370 MiB; 512 MiB × 1: +510 MiB (Buffers peak 1001 MiB); 512 MiB × 2: **+1031 MiB** (Buffers peak 1534 MiB) |
| Uploads, streaming | see below: +43 to +70 MiB at every size |
| Soak, 6 min in Docker (Node 24, 768 MiB limit, 300 sockets with about a tenth reconnecting every few seconds, 10 senders, 20 800 messages) | no crash, no growth trend: RSS 463–488 MiB, heap 237–339 MiB sawtoothing with the garbage collector, event-loop delay below the sample resolution. Six minutes shows no leak; it cannot rule out a slow one (run `SOAK_MINUTES=60`). **It does show where the memory goes: about 1 MiB of heap per gateway session** (next paragraph). |

**Second weak point: the resume buffer.** Each gateway session keeps its own ring of the last 1000 events or 2 minutes (07 §4.5) so a dropped connection can resume; the frames are serialised per session (each carries its own sequence number). In a busy channel every ring is full, and a session that has just disconnected keeps its ring for the whole window: the soak held 250 to 440 sessions and about 300 MiB of heap. That is fine at 25 sockets and a problem at a few hundred in a busy server. Options, not built: a smaller `ringBufferEvents` for the web client (it refetches history on a failed resume anyway), or one shared event log with a cursor per session (the frame is serialised once and the sequence number is added on send). I also tried serialising each payload once per event instead of once per socket: no measurable change here (client and server share the thread), so it was not kept. A load run with the client in its own process would settle whether fan-out CPU is worth more work.

**Was the upload memory a real risk? Yes, and it is fixed (streaming uploads, built after the first report).** The default 25 MiB limit cost about 47 MiB per running upload and the 512 MiB ceiling about a gigabyte at its peak, so a few members together could take a 1 GB machine down. Uploads now stream: the body goes to storage chunk by chunk while it is counted (the limit stops it part way and the storage port removes the partial file) and hashed, the first 16 bytes decide the type, and only an **image up to 48 MiB** is read back to decode and thumbnail, inside the memory budget (M5-12 now guards that step). Bigger images are stored as downloads without a thumbnail. Measured with the same load run: 25 MiB × 8 now +70 MiB, 100 MiB × 4 +43 MiB, 256 MiB × 2 +54 MiB, 512 MiB × 1 +64 MiB, **512 MiB × 2 +68 MiB (was +1031 MiB)**. A test uploads 200 MiB and checks the process does not grow by anything near the file size. The ceiling was raised from 512 MiB to **4 GiB** (`MAX_FILE_BYTES_CEILING`; the owner's limit under it is unchanged and editable). The person's remaining quota is read before the first byte is stored and the body is stopped part way when it would not fit; a cut connection, an over-limit body and a quota overrun all remove the partial object (tests: 600 MiB streams with bounded memory, abort, quota).

### Built

`moderation` module (kick, ban and unban with message purge, timeout, server mute and deafen that survive rejoining, move and disconnect, audit log, ban list), hierarchy through `authorizeAction`, live effect on sessions, sockets and voice, and 23 end-to-end tests; 70 new matrix cells; web: moderation actions on the member card, the Moderation pane (audit log with filter and paging, ban list), server-mute icons, notices. Voice E2EE: key service, epochs in the room metadata, `E2EE_KEY_UPDATE`, `GET /voice/channels/:id/e2ee-key`, mode per channel and per server, web client (worker, indexed key provider, re-sync after decrypt errors, lock indicator, notices), 7 server tests and 2 media-test steps. `tincan backup`, `tincan restore`, `tincan e2ee rotate-secret`, restore-and-compare tests, pre-migration backup tests, pruning. Metrics module and registry, the `dashboards` profile (Prometheus, Grafana with a provisioned dashboard, alert rules), request IDs. Rate limits, gateway caps, log redaction, the route audit test, headers (`Cross-Origin-Opener-Policy`), the dependency audit in CI. `tools/load`, `tools/upgrade-rehearsal`, the guides.

### Cut or deferred

| What | Where it goes |
|---|---|
| `tincan backup --encrypt` (age) | Not built. Pipe the archive through `age` or `gpg` (admin guide). |
| Scheduled backups from inside the app (`backup.hook`), off-host upload, daily/weekly retention | Not built. Host cron plus `--keep N`, and `rclone` for the copy, are documented. |
| An endpoint to disable an account (`ACCOUNT_DISABLED` exists, nothing sets it) | Ban covers it; no UI. |
| Reports from members, auto-moderation, word filters | Not in v1 (15 §7). |
| Image scanning (Trivy), SBOM, cosign, ZAP baseline, an external review | Release work (M7); CodeQL and `pnpm audit` run on every change now. |
| S-09 (Electron renderer) and S-13 (signed releases) | M6 and v1.0. |
| E2EE with AV1, in Firefox and Safari, on a phone | Untested (qa/m5.md). The client reports support and the server refuses cleanly. |
| A separate client process for the load test; LiveKit capacity on the VPS | Follow-up; spike D1 and qa/m3.md §F cover LiveKit. |
| Accessibility and performance pass on the web client | **Only what costs nothing was done:** the new screens use the existing components (labelled controls, dialogs with focus trap, icons with names, no colour-only state); bundle sizes are recorded below. No screen-reader or keyboard run, no axe run, no profiling: those need a person (qa/m5.md §J). |

Bundle at the end of M5 (`pnpm build`): main chunk 731 kB (225 kB gzipped), LiveKit client 534 kB (139 kB), E2EE worker 98 kB (loaded only in an encrypted call), settings 58 kB, RNNoise 153 kB wasm. The "larger than 500 kB" warning was there before M5.

### What I need from you

See [qa/m5.md](qa/m5.md). In short: review the branch (nothing is pushed, merged or deployed; streaming uploads are in); the rows marked **VPS** or **people** need the real server and another person; to use the new pieces on mkarl.io add `TINCAN_MODULES__METRICS__TOKEN`, the Caddy changes and (optionally) the `dashboards` files as the admin guide says; decide M5-1, M5-3 and M5-12, 
