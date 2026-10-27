# 16. Testing Strategy & CI/CD

Test depth matches risk. The highest-risk areas are permissions, realtime
state consistency, media connectivity, migrations/backups, and the desktop
bridge. A solo or small team cannot test everything manually, so automation
focuses on logic and contracts, and a structured manual matrix covers hardware
and OS behaviour that automation cannot.

## 1. Test pyramid

```
            ┌───────────────────────┐
            │ Manual platform matrix│  (hardware, Wayland, audio quality)
         ┌──┴───────────────────────┴──┐
         │ E2E: web + Electron + media │  (Playwright, fake devices)
      ┌──┴─────────────────────────────┴──┐
      │ Integration: server+DB+LiveKit    │  (both DB dialects)
   ┌──┴───────────────────────────────────┴──┐
   │ Contract & module tests (ports, matrix) │
┌──┴─────────────────────────────────────────┴──┐
│ Unit tests (domain, permissions, protocol)    │
└───────────────────────────────────────────────┘
```

## 2. Unit tests (Vitest)

| Area | Examples |
|---|---|
| Permission engine (11 §2.3–2.4) | Table-driven fixtures: base + overwrites order, ADMINISTRATOR bypass, owner, timeouts, hierarchy; property tests (idempotence, monotonicity of deny) |
| Protocol | zod schemas accept/reject, gateway frame encoder/decoder, close-code mapping, sequence/resume ring buffer |
| Module loader | Dependency ordering, cycles, conflicts, config validation errors (messages asserted) |
| Event bus | Ordering, idempotency, error isolation |
| Auth | Password policy, token hashing, invite redemption race (transaction) |
| E2EE | HKDF derivation determinism, rotation schedule, key index wrap-around |
| Client | Reducers/stores, message window logic (gaps, around, prepend), markdown sanitiser, unread logic |
| Audio logic | Gate hysteresis state machine, preset resolution, fallback decision logic (pure parts) |
Coverage guidance: high on domain/permission/protocol code (≥ 90% lines), no
global % gate that encourages low-value tests.

## 3. Contract tests (ports)

Shared suites that **every adapter must pass**:
- **Database:** CRUD, transactions, constraint behaviour, pagination ordering, FTS `SearchIndex` semantics including catch-up after a crash between commit and indexing (outbox, 06 §3.14), migration up path. SQLite only in v1; Postgres joins when its post-v1 adapter does (18 T32).
- **Storage:** put/get/delete, range reads, signed URL behaviour, key validation (traversal attempts) for local; S3 (MinIO container) with the post-v1 adapter.
- **PubSub:** publish/subscribe, kv TTL semantics, atomic `incr`, lease behaviour; memory (Redis with the post-v1 adapter).
- **Auth adapters:** `Identity` mapping, failure modes; OIDC against a mock provider (e.g. a local test IdP container).

## 4. Module matrix tests

Automated boot matrix (04 §11):
1. Each module alone with its required dependencies.
2. Full set minus each non-core module.
3. Known-conflict configurations expect boot failure with specific messages.
4. For each configuration: `/capabilities` shape snapshot, gateway rejects disabled-feature ops, no leftover routes, migrations create only owned tables.
Static check: lint rule forbids cross-module imports except `ModuleApi` types.

## 5. Integration tests

Server booted in-process with real adapters and a real LiveKit container
(dev mode):
- REST + gateway scenarios: register via invite, login, create channel, send message, edit/delete, reactions, uploads, search, read-state, role changes mid-session (events delivered/withdrawn), kick/ban propagation.
- **Authorisation matrix:** generated tests of every endpoint × representative roles (owner, admin, moderator, member, restricted member, outsider) × channel overwrite scenarios; asserts allow/deny and absence of data leakage (11, 15 S-04/S-05).
- Voice server flow: join → token claims decode correctly → webhook processing → presence → reconciliation after dropped webhooks → permission revoke triggers `updateParticipant`; a ban whose `removeParticipant` call is forced to fail is still enforced by the next reconciler pass (S-16); an app restart mid-call keeps E2EE keys (no rekey).
- Rate limiting, setup flow (token required), invite races, session revocation, resume replay correctness (including `INVALID_SESSION`).
- Migration tests: apply all migrations from empty; **upgrade tests** from fixtures of the previous N−1 and N−2 released schemas with sample data; downgrade-protection test.
- Backup/restore test: create data → `tincan backup` → wipe → `tincan restore` → boot → smoke-check counts and a file download (N-008). Also: the pre-migration backup taken after an unclean stop contains every committed transaction (18 T28).
- Failure injection: DB busy (SQLite), Redis down (degraded behaviour), LiveKit down (`UNAVAILABLE`, text fine), webhook duplicates/out-of-order.

## 6. Media tests

Headless Chromium with fake media devices:
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
--use-file-for-fake-audio-capture=<wav> --use-file-for-fake-video-capture=<y4m>`.

- **Two/three-client call:** join, assert via `RTCPeerConnection.getStats()` that inbound audio bytes/levels increase, correct codec, expected packet loss tolerance; mute/unmute propagation; deafen behaviour.
- **Screenshare:** fake display capture (`--auto-select-desktop-capture-source`) publishes; viewer opt-in subscribes; verify frames decoded and resolution layer selection.
- **Upload independence (G4):** one publisher, 1 vs 5 viewers (headless clients); measure publisher `outbound-rtp` bitrate; assert it stays within a tolerance band and that unsubscribed layers stop (dynacast).
- **Simulcast/adaptive:** throttle viewer bandwidth (network emulation via `tc`/Chrome DevTools protocol) and assert the layer drops.
- **E2EE:** correct-key clients see content (checksummed test pattern); wrong-key client fails; rotation after kick; simulcast+E2EE works (D4); speaker-level sharing under E2EE.
- **Reconnect:** drop network (CDP offline/online), switch interface, server restart of app (calls continue) and of LiveKit (clients rejoin prompt).
- **TURN paths:** block UDP with firewall rules in a test network namespace to force TCP/TURN; verify connection still works (D6).
These run in a CI job with Docker; flakiness controlled with generous timeouts and retries on infrastructure steps only (not on assertions).

## 7. Audio quality & performance harness (09 §12)

Nightly/manual workflow:
- Run the denoiser worklet offline against the noise corpus; compute objective metrics (e.g. DNSMOS-style, speech-preservation checks) and compare tiers; store results as artifacts and track trends.
- CPU/latency benchmark in headless Chromium on a pinned reference runner and on a documented low-end machine; fail CI on > X% regression in per-quantum processing time.
- Artefact checks: click detection on gate transitions, clipping detection, silence leak (gate closing).
- Human listening tests recorded in a repo-tracked log before changing defaults.

## 8. End-to-end UI tests (Playwright)

Web client against a full stack (Compose): onboarding/invite flow, send/receive messages across two browser contexts, unread badges, role-based UI changes, permission-denied UX, voice join/leave with fake devices, settings persistence, accessibility checks (axe-core) on key screens, keyboard navigation flows, responsive layouts (mobile viewport).
Desktop: Playwright `_electron` launches the packaged app: first-run instance entry, deep-link handling, tray menu actions (where automatable), IPC abuse attempts rejected, update flow against a local update server, navigation lock tests (13 §10).
Visual regression: optional screenshots for core screens; thresholds to avoid noise.

## 9. Performance & load tests

| Target | Tool | Scenario | Goal |
|---|---|---|---|
| REST/gateway | k6 (or custom WS load script) | 200 users, 20 msgs/s total, gateway fan-out | p95 < 300 ms (N-002), steady memory |
| SQLite | custom | Sustained writes with concurrent reads | No lock errors, p95 write < 50 ms |
| Event-loop blocking | custom | Scheduled backup, maintenance job and heavy search on a ~4 GB fixture while 200 sockets heartbeat | No missed heartbeats; p95 delivery stays < 300 ms (18 T28) |
| SFU | `lk load-test` (LiveKit CLI, verify) | 25 audio publishers; 1 video publisher × 10 subscribers | CPU/egress per 08 §13 expectations |
| Client | Playwright traces/Lighthouse | Open busy channel (10k messages), scroll | 60 fps scroll, memory bounded |
| Reconnect storm | custom | 200 sockets drop & resume simultaneously | No server overload; resume works |

## 10. Security testing (15 §9)

SAST (CodeQL/Semgrep), dependency audit (`pnpm audit`, OSV), licence scan, secret
scanning (gitleaks), container scan (Trivy/Grype), ZAP baseline on staging,
fuzzing (gateway frames; Markdown renderer; upload parsers), authorisation
matrix (§5), Electron abuse tests (§8), SSRF test suite for link previews
(private IPs, redirects, DNS rebinding simulation).

## 11. Manual test matrix (release candidates)

Executed by the maintainer plus friends (dogfooding group) using a checklist:

| Axis | Values |
|---|---|
| OS | Windows 10/11; macOS latest and previous (Intel + Apple silicon); Ubuntu LTS (X11 + Wayland), Fedora GNOME Wayland, KDE Plasma Wayland |
| Network | Home Wi-Fi, mobile hotspot (CGNAT), VPN, corporate-like (UDP blocked), switching networks mid-call |
| Hardware | Built-in laptop mic, USB mic, Bluetooth headset (profile switching!), HDMI audio, multi-monitor, HiDPI |
| Scenarios | Join/leave, PTT global, screenshare with/without audio (each OS), camera, 3+ people, E2EE channel, long call (1 h+), sleep/wake, device unplug, update install, first-run setup, upgrade from previous version |
Results are recorded per release in `docs/qa/<version>.md`.

## 12. CI/CD pipeline

| Stage | Trigger | Jobs |
|---|---|---|
| **PR checks** (target < 10 min) | every PR | install (frozen lockfile), typecheck, lint, unit, contract (SQLite/memory/local), module matrix, build, licence+secret scan, SAST |
| **Integration** (target < 25 min) | PR (label/paths) and main | LiveKit container (Postgres/Redis/MinIO join with their post-v1 adapters), integration + authorisation matrix + migrations + backup/restore |
| **E2E & media** | main + nightly | Playwright web, media tests, TURN-path test, upload-independence test |
| **Desktop builds** | main + tags | Matrix build on Windows/macOS/Linux runners; packaging; Playwright-Electron smoke on each OS |
| **Nightly** | schedule | Audio harness, load tests, dependency/image scans, long-run soak (30 min call) |
| **Release** | tag `vX.Y.Z` | Build multi-arch images, sign (cosign), SBOM, sign + notarise desktop, publish draft release with checksums, changelog, update feed, docs version |
Caches: pnpm store, Playwright browsers, Docker layers. Required checks gate
merges to `main`; flaky tests are quarantined with an owner and a deadline, not
ignored.

## 13. Environments

| Env | Purpose |
|---|---|
| Local dev | `pnpm dev` + LiveKit dev container |
| CI | Ephemeral containers |
| Staging | Real VPS with real DNS/TLS/TURN for pre-release verification and the manual matrix (the maintainer's own friends instance can serve as canary: run N+1 there first) |
| Production | Hosts' own instances |

## 14. Test data

Seed generator: users, roles, channels, N messages with realistic distribution
(markdown, mentions, attachments), voice fixtures. Deterministic via seed.
Audio/video fixtures committed via Git LFS or generated in CI.

## 15. Definition of done (for a feature)

- Requirements in 01 mapped to tests; permission checks and error paths tested.
- Works with the module disabled (no residue) and enabled.
- The DB contract suite passes (SQLite in v1; both dialects once the Postgres adapter exists).
- Capabilities, docs (user + admin + design delta) updated.
- Accessibility pass (keyboard, labels).
- No new security checklist items unaddressed (15).
- Metrics/logging for operability.

## Open items
- Use LFS for media fixtures or generate on the fly.
- CI provider: GitHub Actions assumed; macOS runner minutes/signing secret handling.
- Hardware-in-the-loop (real devices) is manual only; consider a self-hosted runner for audio benchmarks.
- Mutation testing for the permission engine (nice-to-have).
