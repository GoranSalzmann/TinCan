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
**Status:** Proposed
**Options:** TypeScript (Node), Go, Rust.
**Decision:** TypeScript end to end; Fastify as the HTTP framework (mature plugin ecosystem, schema validation, good WS support via `@fastify/websocket`).
**Alternatives considered:** Hono (lighter, portable across runtimes; fewer batteries), Go (matches LiveKit, but splits the language between server and client and prevents shared types/zod schemas).
**Why:** Shared types and validation schemas between server, web and desktop clients is a big maintenance saver for a small team. You said language preference does not matter, so this optimises for team size.
**Consequences:** Node single-threaded; fine at target scale (media is offloaded to LiveKit). CPU-heavy tasks (image thumbnailing) go to worker threads or a library using native code (sharp).

## ADR-006: Realtime transport for app events
**Status:** Proposed
**Options:** WebSocket, Server-Sent Events + REST, Socket.IO, WebTransport.
**Decision:** Plain WebSocket with a small custom protocol (op codes, sequence numbers, resume). Detailed in 07.
**Why:** Bidirectional, universal, no heavy framework; resume semantics are needed anyway.
**Consequences:** We own reconnect/resume logic (well understood; specified in 07).

## ADR-007: Database access layer and engines
**Status:** Engines settled (18 T32); query builder Proposed
**Options:** Drizzle, Kysely, Prisma, raw SQL.
**Decision:** SQLite only in v1; Postgres is a post-v1 adapter behind the same port (18 T32). Kysely or Drizzle; final pick at scaffolding time; criteria: typed queries, async transactions that work on better-sqlite3 (spike D5), no code generation step in the dev loop.
**Conventions kept so a later Postgres adapter stays cheap:**
- No engine-specific types in the schema (IDs are text/ULID, timestamps are integer ms or ISO text, booleans are 0/1, JSON stored as text with app-level validation).
- Full-text search goes through a `SearchIndex` helper (SQLite FTS5 in v1; Postgres tsvector later), fed from the core outbox (06 §3.14).
- Migrations target SQLite in v1; a Postgres adapter would add its own per-dialect branch.
**Consequences:** CI runs one engine in v1. SQLite uses WAL mode, a single writer connection and busy timeout. better-sqlite3 runs on the event loop, so long statements are banned and backups use the incremental backup API (05 §3.1, 18 T28). See 06.

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
- Dependencies are compatible: LiveKit (Apache-2.0), DeepFilterNet (MIT/Apache-2.0), Electron (MIT), React, Fastify, Kysely/Drizzle (MIT/Apache) can all be combined into an AGPL work. Every new dependency must be checked in CI with a licence scanner (GPL-incompatible or proprietary licences rejected).
- **AGPL section 13:** anyone who runs a *modified* Tin Can as a network service must offer their users the corresponding source. Build in a "Source code" link (About dialog and `/capabilities`, configurable URL) so Hosts can comply easily.
- Contributions: decide whether to require a CLA/DCO. Recommendation: DCO sign-off only. If you later want to offer a commercial licence, you would need a CLA, so choose before accepting outside contributions.
- Copyright headers/SPDX tags (`AGPL-3.0-or-later` vs `-only`) to be chosen at scaffold; recommendation `AGPL-3.0-or-later`.
- Third-party notices file generated at build and bundled in desktop installers.
- The Electron installers and Docker images carry the licence text and a source offer.

## Open items
- ADR-005 Fastify vs Hono (final at scaffold).
- ADR-007 Kysely vs Drizzle (final at scaffold).
- ~~ADR-014 cert sharing between Caddy and LiveKit~~ Resolved: shared certificate, deferred reload (18 T30; confirm in D6).
- ADR-018 resolved: SPDX `AGPL-3.0-or-later` with DCO sign-off, no CLA (triage, 18 §F).
