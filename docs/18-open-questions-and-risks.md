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
