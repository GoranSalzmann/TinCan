# 03. Technology Decisions (ADRs)

Each record: context, options, decision, consequences. Status is one of
**Settled** (you decided), **Proposed** (my call, challenge it), **Open** (needs you).

---

## ADR-001: SFU media architecture
**Status:** Settled
**Context:** Multi-party voice plus video; publisher upload must not scale with viewers.
**Options:** Mesh P2P (upload ∝ viewers), MCU (server mixes; CPU-heavy, adds latency), SFU (forwards streams).
**Decision:** SFU.
**Consequences:** Server egress grows with viewers (bandwidth is the cost driver). Publisher uploads one stream, or a few simulcast layers. Server never decodes media, which also makes E2EE possible.

## ADR-002: LiveKit as the SFU, locked in
**Status:** Settled
**Options:** LiveKit, mediasoup, Janus, Pion (custom), str0m.
**Decision:** LiveKit. No media abstraction layer; use `livekit-server-sdk` and `livekit-client` directly.
**Consequences:**
- Full access to simulcast, dynacast, adaptive stream, E2EE, data channels, webhooks, egress.
- Switching SFU later means a rewrite of voice/video modules and client transport. Accepted.
- We depend on LiveKit's release cadence and licence (Apache-2.0). Pin versions; track upstream security advisories (K-03).
- Some LiveKit add-ons (e.g. Krisp noise filter) are Cloud-only and unavailable to us (see ADR-010).

## ADR-003: Modular monolith
**Status:** Settled
**Options:** Microservices, plugin runtime, modular monolith.
**Decision:** One server process; features are internal modules with manifests, toggled by config.
**Consequences:** Simple deploy and debugging. Modules must not import each other (event bus + shared ports). A real third-party plugin API is out of scope; the seams are kept clean to allow it later.

## ADR-004: Ports only where real alternatives exist
**Status:** Settled
**Decision:** Interchangeable: database, file storage, pub/sub, auth. Fixed: LiveKit, Caddy-or-equivalent proxy, TypeScript runtime.
**Consequences:** Each port requires a shared contract test suite that every adapter passes (16). v1 ships one adapter per port, except auth (local + OIDC); Postgres, S3 and Redis adapters are post-v1 (18 T32).

## ADR-005: Language and server framework
**Status:** Proposed (TypeScript). HTTP framework **Settled: Fastify** (you, 2026-10-28, after spike T1; 18 T1).
**Options:** TypeScript (Node), Go, Rust.
**Decision:** TypeScript end to end; Fastify as the HTTP framework (mature plugin ecosystem, schema validation, good WS support via `@fastify/websocket`).
**Alternatives considered:** Hono (lighter, portable across runtimes; fewer batteries), Go (matches LiveKit, but splits the language between server and client and prevents shared types/zod schemas).
**Why:** Shared types and validation schemas between server, web and desktop clients is a big maintenance saver for a small team. You said language preference does not matter, so this optimises for team size.
**Spike T1 (2026-10-28).** Fastify 5.12 (+ `@fastify/websocket`, `fastify-type-provider-zod`, `@fastify/swagger`) against Hono 4.13 (+ `@hono/node-server`, `@hono/node-ws`, `@hono/zod-openapi`), same zod 4 schemas and same gateway code on both. Raw output: `spikes/t1-http/RESULTS.md`.
- Equal: zod validation of params, query and body with our error envelope; OpenAPI 3.1 generated from the route schemas and valid on both; WebSocket Origin check before the upgrade (403); gateway fan-out (both hand frames to `ws`: 1,000 sockets at 50 msg/s, p99 10.7 ms vs 9.9 ms).
- Fastify validates responses at runtime: a handler that returned an extra internal field had it stripped, and a body that broke its schema became a 500. Hono sent both as-is (`@hono/zod-openapi` 1.6.3 has no response validation).
- Fastify passes `maxPayload` to `ws`, so a 70 KiB frame closes with 1009 (07 §4.1 caps client frames at 64 KiB). `@hono/node-ws` 1.3.1 cannot set it; a 20 MiB frame was buffered and processed.
- Throughput: validated POST 16.1k vs 8.4k req/s; history GET with 50 messages 8.2k vs 7.0k req/s (Fastify was also validating the response).
- Hono is lighter: 10 vs 70 packages, 15 vs 27 MB installed, startup 133 vs 235 ms, 96 vs 114 MB RSS at ready.
- **Recommendation: Fastify.** Response stripping and the frame cap guard against leaking internal fields and memory abuse (15) without per-handler code. Hono would need `Schema.parse()` in every handler and a hand-attached `ws` server.
**Consequences:** Node single-threaded; fine at target scale (media is offloaded to LiveKit). CPU-heavy tasks (image thumbnailing) go to worker threads or a library using native code (sharp).

## ADR-006: Realtime transport for app events
**Status:** Proposed
**Options:** WebSocket, Server-Sent Events + REST, Socket.IO, WebTransport.
**Decision:** Plain WebSocket with a small custom protocol (op codes, sequence numbers, resume). Detailed in 07.
**Why:** Bidirectional, universal, no heavy framework; resume semantics are needed anyway.
**Consequences:** We own reconnect/resume logic (well understood; specified in 07).

## ADR-007: Database access layer and engines
**Status:** Engines settled (18 T32). Query builder **Settled: Kysely** (you, 2026-10-28, after spike D5; 18 T2).
**Options:** Drizzle, Kysely, Prisma, raw SQL.
**Decision:** SQLite only in v1; Postgres is a post-v1 adapter behind the same port (18 T32). Kysely on better-sqlite3, chosen against these criteria: typed queries, async transactions that work on better-sqlite3, no code generation step in the dev loop.
**Spike D5 (2026-10-28).** Kysely 0.29.7 and drizzle-orm 0.45.4 (plus 1.0.0-rc.5) on better-sqlite3 13 with FTS5. Raw output: `spikes/d5-db/RESULTS.md`.
- Async transactions: Kysely serialises every query on the single connection through a mutex, and a transaction holds it from `begin` to `commit`. In 300 concurrent requests with awaits inside transactions and 25 % rollbacks, nothing interleaved, no write was lost and no read saw uncommitted rows. The control (BEGIN, await, COMMIT without a mutex) failed all of these.
- Drizzle's better-sqlite3 transactions are synchronous only, and an async callback type-checks. 0.45.4 throws at the first `await` and runs the rest in autocommit. 1.0.0-rc.5 commits before the first `await` and still hands the caller the callback's error, so a "failed" transaction keeps its rows. Drizzle is only safe through its async `sqlite-proxy` driver plus our own mutex (71 µs per point query).
- Typed queries: both reject unknown columns, wrong value types, missing required columns and unselected fields at compile time. With FTS5, Kysely keeps the query typed and uses `sql` only for `MATCH`/`bm25()`. Drizzle cannot declare virtual tables, so those queries are raw SQL with an unchecked row type. `Kysely<DB>` narrows to a module's own tables without a cast, which gives each module a handle that cannot name other modules' tables (04).
- Migrations: Kysely uses plain TS migration objects per module with a ~40-line runner that does what 06 §8 asks (per-module versions, refuses a newer schema, a failing migration leaves nothing behind). Drizzle runs `drizzle-kit generate` on every schema change (SQL plus snapshot JSON, 0.7 s) and needs a hand-written custom migration for FTS5. Drizzle's schema is one source for types and DDL. Kysely's table types are hand-written next to the migrations, so a test must apply all migrations to an empty database and exercise the queries.
- Cost per point query on the main thread: raw 3.9 µs, Kysely 41.5 µs, Kysely with a prepared-statement cache 9.7 µs, Drizzle 66.6 µs (4.8 µs with `.prepare()`).
**Conventions for the Kysely adapter (from D5):** `begin immediate` instead of Kysely's deferred `begin`; the root handle throws inside a transaction (an AsyncLocalStorage guard; without it, using `db` instead of `tx` deadlocks every later query); a prepared-statement cache; per-module table types and migrations; `auto_vacuum=INCREMENTAL` before the first table is created.
**Conventions kept so a later Postgres adapter stays cheap:**
- No engine-specific types in the schema (IDs are text/ULID, timestamps are integer ms or ISO text, booleans are 0/1, JSON stored as text with app-level validation).
- Full-text search goes through a `SearchIndex` helper (SQLite FTS5 in v1; Postgres tsvector later), fed from the core outbox (06 §3.14).
- Migrations target SQLite in v1; a Postgres adapter would add its own per-dialect branch.
**Consequences:** CI runs one engine in v1. SQLite uses WAL mode, a single writer connection and busy timeout. better-sqlite3 runs on the event loop. D5 measured what may run there; search queries and scheduled snapshots go to one DB worker thread with its own read connection (05 §3.1, 18 T28). See 06.

## ADR-008: Storage, pubsub, auth adapters
**Status:** Settled (18 T32)
**Decision:**
- Storage: `local` in v1; `s3` (any S3-compatible) post-v1.
- PubSub: `memory` in v1 (single node); `redis` post-v1.
- Auth: `local` (argon2id), `oidc`. Both resolve to a normalised `Identity`.
**Consequences:** Interfaces are intentionally tiny (see 05).

## ADR-009: Desktop shell
**Status:** Proposed
**Options:** Electron, Tauri, native per-OS.
**Decision:** Electron.
**Why:** Bundled Chromium gives identical WebRTC, screen capture and codec behaviour on all three OSes. Tauri relies on system webviews; WebKitGTK on Linux has weak WebRTC and screen-capture support, and cross-platform desktop is your top client priority. Electron also gives `desktopCapturer`, global shortcuts, tray, auto-update.
**Consequences:** ~100 MB installer, higher RAM. Mitigated by keeping the renderer lean and the main process thin. Security hardening (contextIsolation, sandbox, CSP) mandatory (13, 15). Wayland screen capture and global hotkeys need explicit testing (K-05).

## ADR-010: Noise suppression and audio processing
**Status:** Proposed
**Decision:** Pipeline: browser echo cancellation ON, browser noise suppression OFF, DeepFilterNet-class neural denoiser in an AudioWorklet, optional gate/limiter, Opus with FEC/RED. RNNoise as lightweight fallback; browser built-in as last-resort fallback. Details in 09.
**Why:** DeepFilterNet is open source and near commercial quality. Krisp is not usable with self-hosted LiveKit.
**Consequences:** WASM bundle size and CPU cost; automatic fallback on underruns; user-selectable presets. Native Rust build on desktop is a later optimisation.

## ADR-011: End-to-end encryption scope
**Status:** Proposed
**Decision:** Voice/video E2EE via LiveKit insertable streams with a per-channel (per-session-epoch) shared key distributed by the app server over the authenticated gateway. Text is **not** E2EE in v1 (TLS + at-rest protection; Host is trusted).
**Why:** Media E2EE is cheap and meaningful; text E2EE kills search, history for new joiners, bots, previews, and costs a protocol (MLS/Double Ratchet) that is a project of its own.
**Consequences:** With voice E2EE on, server-side recording/transcription of that room is impossible; the module loader warns on this conflict. Key distribution trust is the app server, so a malicious Host can still obtain keys. This protects against passive network/LiveKit-host compromise, not against a hostile app-server operator. 10 states this threat model plainly.

## ADR-012: Client UI stack
**Status:** Proposed
**Decision:** React 18+, Vite, TypeScript, Zustand for state, Tailwind for styling, Radix primitives for accessible components. One renderer codebase used by both web and Electron.
**Consequences:** Desktop-only features (global mute shortcuts, tray, source picker) are reached through a `PlatformBridge` interface with web and Electron implementations (12, 13).

## ADR-013: Monorepo tooling
**Status:** Proposed
**Decision:** pnpm workspaces; Turborepo optional later. TypeScript project references. Vitest for unit, Playwright for e2e.

## ADR-014: Reverse proxy and TLS
**Status:** Proposed
**Decision:** Caddy 2 for automatic HTTPS. LiveKit's own TURN/TLS needs certificates too; Caddy-issued certs are shared with LiveKit or LiveKit's built-in ACME is used (decide in 14). **Decided (18 T30):** Caddy's certificate is shared with LiveKit for TURN/TLS on 5349, and LiveKit is reloaded only when no rooms are active or the certificate nears expiry (14 §2.3).
**Consequences:** Hosts need a domain and ports 80/443 reachable.

## ADR-015: One instance = one community?
**Status:** Settled (D9): Option A for v1, with `space_id` in the schema as recommended below.
**Options:**
- **A. Single community per instance.** No "server" concept in the UI; simplest; matches "friends and small communities" if each community self-hosts.
- **B. Multi-space instance.** Discord-like: one instance hosts many independent "spaces", each with own channels/roles/members.
**Recommendation:** Schema includes a `space_id` on all scoped tables from day one (cheap), but v1 UI and API assume exactly one space. Upgrading to B later is then a UI/permission change, not a data migration.
**Resolved:** a single community per install.

## ADR-016: IDs
**Status:** Proposed
**Decision:** ULID (or UUIDv7) as text primary keys: time-sortable, usable for cursor pagination, no coordination, identical across SQLite/Postgres.

## ADR-017: Observability stack
**Status:** Proposed
**Decision:** Structured JSON logs (pino), `/healthz` and `/readyz`, optional `/metrics` (Prometheus format) behind a module toggle. No bundled Grafana; docs show how to add it.

## ADR-018: Licensing of this project
**Status:** Settled. The project is **AGPL-3.0**; the product name is **Tin Can** (D11).
**Context:** You want protection against closed-source forks and hosted clones.
**Consequences:**
- Dependencies are compatible: LiveKit (Apache-2.0), DeepFilterNet (MIT/Apache-2.0), Electron (MIT), React, Fastify, Kysely (MIT) can all be combined into an AGPL work. Every new dependency must be checked in CI with a licence scanner (GPL-incompatible or proprietary licences rejected).
- **AGPL section 13:** anyone who runs a *modified* Tin Can as a network service must offer their users the corresponding source. Build in a "Source code" link (About dialog and `/capabilities`, configurable URL) so Hosts can comply easily.
- Contributions: decide whether to require a CLA/DCO. Recommendation: DCO sign-off only. If you later want to offer a commercial licence, you would need a CLA, so choose before accepting outside contributions.
- Copyright headers/SPDX tags (`AGPL-3.0-or-later` vs `-only`) to be chosen at scaffold; recommendation `AGPL-3.0-or-later`.
- Third-party notices file generated at build and bundled in desktop installers.
- The Electron installers and Docker images carry the licence text and a source offer.

## Open items
- ~~ADR-005 Fastify vs Hono~~ Resolved: Fastify (18 T1).
- ~~ADR-007 Kysely vs Drizzle~~ Resolved: Kysely (18 T2).
- ~~ADR-014 cert sharing between Caddy and LiveKit~~ Resolved: shared certificate, deferred reload (18 T30; confirm in D6).
- ADR-018 resolved: SPDX `AGPL-3.0-or-later` with DCO sign-off, no CLA (triage, 18 §F).
