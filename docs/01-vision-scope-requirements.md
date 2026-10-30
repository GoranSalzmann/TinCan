# 01. Vision, Scope & Requirements

> **Scope change (2026-10-30).** The Electron desktop app is dropped for the foreseeable future; the installable web app (PWA, 12 §14) takes its place (17, M6). Read "desktop app" below as "the web client, installed as an app" where it appears in the vision, G8 and the priority list. Requirements that need a native shell are not met: global mute/deafen/leave shortcuts and any global push-to-talk key (R-035), pop-out of a stream into its own window beyond the browser's picture-in-picture (R-045), and system-audio capture on every OS. They return only if the desktop app is revived (13 stays as the shelved design).

## 1. Vision

A self-hostable, Discord-style chat platform for friends and small communities:
persistent text channels, ad hoc voice channels, and on-demand camera or
screenshare, with excellent audio quality, delivered as a polished cross-platform
desktop app (plus a browser client), runnable by a non-expert with one command.

**Priority order (when goals conflict):**
1. Finished, polished product over architectural purity.
2. Desktop experience on Windows, macOS and Linux.
3. Audio quality.
4. Easy self-hosting.
5. Modularity (bounded: see 03).

## 2. Users and scale

| Persona | Description | Needs |
|---|---|---|
| **Host** | Technical-ish friend who runs the server on a VPS or home box | One-command install, low maintenance, backups, upgrades, clear connectivity diagnostics |
| **Member** | Friend or community member, any OS | Download app or open link, join, talk, share screen, no config |
| **Moderator** | Trusted member | Kick/mute/ban, manage channels |

**Target scale:** one instance serves roughly 5 to 200 registered users, with up
to ~25 concurrent in voice across channels and up to ~10 viewers per stream.
Larger scale is not a design goal but should not be architecturally blocked
(the DB, storage and pubsub ports stay; Postgres, Redis and S3 adapters are post-v1, 18 T32).

## 3. Goals

- G1. Persistent text chat with history and search.
- G2. Voice channels users drop into and out of freely.
- G3. Camera and screenshare published ad hoc inside a voice channel.
- G4. Publisher upload does **not** grow with viewer count.
- G5. Best practical noise suppression and audio processing.
- G6. Feature toggles; swappable DB/storage/pubsub/auth behind ports (v1 ships one adapter per port, plus local and OIDC auth; 18 T32).
- G7. Voice/video end-to-end encryption available.
- G8. First-class cross-platform desktop app.

## 4. Non-goals (v1)

- Native mobile apps (web client must be usable on a phone browser, but no app).
- Federation between instances.
- Third-party plugin/bot API (internal seams are designed to allow it later).
- Text E2EE and encrypted DMs.
- Swappable media server (LiveKit is fixed).
- Large-event / webinar scale, live streaming to public audiences.
- Server-side transcription, AI features.
- Billing, multi-tenant SaaS operation.
- Postgres, Redis and S3 adapters (the ports and their contract tests are in v1; 18 T32).
- Deferred to v1.1+ (decided in 18 §F): stream preview thumbnails, camera background blur/virtual backgrounds, welcome/rules/announcement features, GIF picker, custom emoji, soundboard.

## 5. Functional requirements

### 5.1 Accounts and access
- R-001 MUST support local accounts (username + password, argon2id).
- R-002 MUST be invite-only by default; open signup MAY be a toggle.
- R-003 MUST support invite links with optional expiry and max uses.
- R-004 SHOULD support OIDC login as an alternative auth adapter.
- R-005 MUST support multiple concurrent sessions per user, individually revocable.
- R-006 MUST support profile: display name, avatar, status text.

### 5.2 Text
- R-010 MUST provide text channels with persistent history.
- R-011 MUST deliver new messages in real time to online members.
- R-012 MUST paginate history by cursor (no offset paging).
- R-013 MUST support edit and delete of own messages; moderators delete any.
- R-014 SHOULD support replies (reference to a prior message) and @mentions.
- R-015 SHOULD support file/image upload with inline image preview.
- R-016 SHOULD support full-text search within a channel and across accessible channels.
- R-017 SHOULD support emoji reactions (MAY slip to v1.1).
- R-018 MUST track per-user read state and show unread/mention badges.
- R-019 MAY support link previews (privacy-sensitive; server-side fetch, off by default).
- R-020 MUST sanitise and safely render message content (Markdown subset).
- R-021 MUST enforce a per-user total upload quota (default configurable) and warn admins when instance disk usage passes a threshold.

### 5.3 Voice
- R-030 MUST provide voice channels any permitted member can join/leave at will.
- R-031 MUST show who is currently in each voice channel without joining.
- R-032 MUST support self mute, self deafen, per-user local volume.
- R-033 MUST show speaking indicators.
- R-034 MUST support input/output device selection and a mic test with level meter.
- R-035 MUST support push-to-talk (in-window) and voice-activity modes; desktop MUST offer global toggle-mute/deafen/leave shortcuts. Global hold-to-talk is a v1.1 option (18 §F).
- R-036 SHOULD support moderator server-mute / move / disconnect.
- R-037 MUST recover from network changes (reconnect, ICE restart) without user action.

### 5.4 Video and screenshare
- R-040 MUST allow publishing camera and/or screen while in a voice channel.
- R-041 MUST allow viewers to opt in or out of watching a given stream.
- R-042 MUST support screenshare with system/app audio where the OS allows (Windows, Linux; macOS limited).
- R-043 MUST offer quality presets (e.g. 720p30, 1080p30, 1080p60) and a low-upload mode.
- R-044 MUST adapt quality per viewer without increasing publisher upload per viewer (see 08).
- R-045 SHOULD allow a viewer to pop a stream into its own window (desktop).
- R-046 MUST show the person sharing a screen or camera who is currently watching (viewer list on the sharing bar). Viewers are told that the sharer can see them.
- R-047 MUST give screenshare audio its own volume control and mute, separate from the sharer's voice.

### 5.5 Administration
- R-050 MUST support roles with a permission bitset (see 11).
- R-051 MUST support channel creation, rename, reorder, delete, and per-channel permission overrides.
- R-052 MUST support kick, ban, timeout.
- R-053 SHOULD keep an audit log of admin actions.
- R-054 MUST provide a first-run setup flow that creates the owner account.

### 5.6 Modularity
- R-060 MUST allow each feature module to be enabled/disabled by config.
- R-061 MUST validate module dependencies at boot with clear errors.
- R-062 MUST expose enabled capabilities to clients so UI adapts.
- R-063 MUST define ports for DB, storage and pubsub, each with a contract test suite; v1 MUST ship the SQLite, local-storage and in-memory pubsub adapters. Postgres, S3 and Redis adapters are post-v1 (18 T32).

## 6. Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| N-001 | Latency | Voice end-to-end (mouth to ear) target < 250 ms on healthy networks |
| N-002 | Text latency | Message delivery to online clients p95 < 300 ms |
| N-003 | Upload | Publisher upload independent of viewer count (SFU + simulcast/dynacast) |
| N-004 | Audio | 48 kHz Opus, echo-cancelled, neural-denoised by default on capable hardware |
| N-005 | CPU | Denoiser < ~10% of one modern core; auto-fallback if underruns occur |
| N-006 | Install | Host goes from blank VPS to working instance in under 15 minutes |
| N-007 | Footprint | Idle server (no media) < 300 MB RAM excluding LiveKit |
| N-008 | Durability | All state recoverable from DB dump + storage directory + config |
| N-009 | Security | See 15; TLS everywhere, secrets never in client, argon2id, rate limiting |
| N-010 | Upgrades | Forward-only migrations; app warns on client/server version skew |
| N-011 | Accessibility | Keyboard navigable, screen-reader labels, reduced-motion respected |
| N-012 | i18n | Strings externalised from day one; English only at launch |
| N-013 | Observability | Structured logs, health endpoints, Prometheus-style metrics (toggle) |

## 7. Constraints and assumptions

- Single developer or very small team; every design choice is weighed against
  maintenance burden.
- Host has a public IP or can forward ports, and a domain name (needed for TLS
  and for WebRTC/TURN on 443).
- Bandwidth, not CPU, is the dominant server cost (08).
- LiveKit is open source (Apache-2.0) and self-hostable; its licence and release
  cadence are accepted as a dependency risk (18).
- Browsers/Chromium provide the WebRTC stack; we do not write media code.

## 8. Success criteria

The design is "done" when a Host can install it with Docker Compose, three
Members on different OSes can chat, talk with good audio, and one can share a
1080p screen to two others, with the sharer's upload unchanged between one and
two viewers, and the Host can back up, upgrade and restore without data loss.

## Open items
- Resolved (see 18): one community per instance; search is global across channels the user can see; no DMs, threads, or attached voice text chat in v1.
