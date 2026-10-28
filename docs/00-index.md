# Design Documentation: Tin Can (self-hosted voice, video & text chat)

> Product name: **Tin Can**. Licence: **AGPL-3.0**.
> (The folder is still called `SelfHostedChat`; rename it whenever convenient, nothing depends on it.)
> Status: **Signed off 2026-10-28.** M0 (spikes and wireframes) in progress; no product code yet.

## How to read this

The docs go top-down. Each level assumes the one above it.

| Level | Question it answers | Docs |
|---|---|---|
| 0. Why | What are we building, for whom, and what are we *not* building? | 01 |
| 1. Shape | What are the big parts and how do they connect? | 02, 03 |
| 2. Structure | How is the code organised so features can be toggled? | 04, 05 |
| 3. Detail | Data, wire protocols, media, audio, security | 06, 07, 08, 09, 10, 11 |
| 4. Surfaces | Client apps and the desktop shell | 12, 13 |
| 5. Operate | Deploy, secure, test, ship | 14, 15, 16, 17 |
| 6. Close | What is still undecided, what could go wrong | 18 |

## Document map and status

| # | Document | Status |
|---|---|---|
| 00 | Index (this file) | Written |
| 01 | Vision, scope, requirements | Written |
| 02 | High-level architecture | Written |
| 03 | Technology decisions (ADRs) | Written |
| 04 | Feature module system | Written |
| 05 | Server internals | Written |
| 06 | Data model | Written |
| 07 | API and realtime protocol | Written |
| 08 | Voice, video & screenshare (LiveKit) | Written |
| 09 | Audio processing pipeline | Written |
| 10 | End-to-end encryption | Written |
| 11 | Auth, roles & permissions | Written |
| 12 | Client architecture (web/shared UI) | Written |
| 13 | Desktop app (Electron) | Written |
| 14 | Deployment & operations | Written |
| 15 | Security & threat model | Written |
| 16 | Testing & CI | Written |
| 17 | Roadmap & milestones | Written |
| 18 | Open questions & risks (living) | Written; updated each batch |

All documents are now drafted. Remaining work before sign-off is **review**, not writing:
facts marked "(verify)" are checked in the M0 spikes (17), and open items in each doc
are triaged through 18. Design-review findings and the decisions taken on them are
in 18 §F and §G.

## Coverage checklist ("is everything accounted for?")

Every item below must map to at least one doc before sign-off. Items marked
with a doc number are covered by that doc once written.

**Product features**
- [x] Accounts, login, sessions (11)
- [x] Invite-only joining (11)
- [x] Persistent text channels, history, pagination (06, 07)
- [x] Message edit/delete, mentions, replies (06, 07)
- [x] File/image uploads and previews (06, 07, 14)
- [x] Ad hoc voice channels: join/leave, mute/deafen, speaking indicators (08, 12)
- [x] Ad hoc camera and screenshare, viewer-side controls (08, 12, 13)
- [x] Presence ("who is in which voice channel") (07, 08)
- [x] Unread tracking and notifications (06, 07, 12)
- [x] Roles and permissions (11)
- [x] Admin/moderation: kick, ban, mute, audit log (11)
- [x] Settings: devices, audio processing, PTT, keybinds (09, 12, 13)

**Cross-cutting**
- [x] Feature toggles + capability discovery (04)
- [x] Interchangeable DB / storage / pubsub / auth: ports in v1, one adapter each (auth: local + OIDC); more adapters post-v1 (04, 05, 06, 18 T32)
- [x] Voice/video E2EE (10)
- [x] Upload bandwidth that does not scale with viewers (08)
- [x] Best-available noise suppression and audio processing (09)
- [x] Config system (04, 14)
- [x] Observability: logs, metrics, health (14)
- [x] Backups, upgrades, migrations (14)
- [x] Threat model (15)
- [x] Testing strategy (16)
- [x] Packaging: Docker, desktop installers, auto-update (13, 14)

**Platforms**
- [x] Desktop: Windows, macOS, Linux (13)
- [x] Web client (12)
- [x] Mobile: explicitly deferred (01, 17)

## Decision log (summary)

Full reasoning lives in 03. One-line summary here so it is visible.

| ID | Decision | State |
|---|---|---|
| D1 | SFU architecture, not mesh/MCU | Settled |
| D2 | LiveKit is locked in; no media abstraction layer | Settled |
| D3 | Modular monolith; features toggled by config | Settled |
| D4 | Swappable ports only for DB, storage, pubsub, auth | Settled |
| D5 | TypeScript end to end | Proposed |
| D6 | Electron desktop shell (not Tauri) | Proposed |
| D7 | SQLite only in v1; Postgres, Redis, S3 adapters post-v1 (18 T32) | Settled |
| D8 | Voice/video E2EE yes; text E2EE no (v1) | Proposed |
| D9 | One instance = one community (schema allows more) | Settled |
| D11 | Name "Tin Can"; licence AGPL-3.0 | Settled |
| D10 | Neural denoiser (DeepFilterNet) in client | Proposed |

"Proposed" means I made the call from our discussion and you should challenge it.
"Needs your call" means I could not infer your preference. See 18.

## Conventions

- **MUST / SHOULD / MAY** are used in the RFC 2119 sense in requirement lists.
- Diagrams are ASCII or Mermaid so they diff well in git.
- Every doc ends with an **Open items** section that feeds doc 18.
- IDs: requirements are `R-xxx`, decisions `D-n`/`ADR-nnn`, risks `K-nn`.
