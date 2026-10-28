# 02. High-Level Architecture

Follows the C4 idea: context, containers, then components. Deeper component
detail lives in 04+ .

## 1. System context (Level 1)

```
 ┌────────────┐   ┌────────────┐   ┌─────────────┐
 │ Desktop app│   │ Web client │   │  Host/Admin │
 │ (Electron) │   │ (browser)  │   │ (CLI, files)│
 └─────┬──────┘   └─────┬──────┘   └──────┬──────┘
       │ HTTPS/WSS + WebRTC               │ SSH, compose, config
       ▼                                  ▼
 ┌──────────────────────────────────────────────────┐
 │                 Tin Can instance                 │
 │  (one host or small cluster, owned by the Host)  │
 └──────────────────────────────────────────────────┘
       │ optional outbound
       ▼
   OIDC provider · S3 · SMTP/push (all optional)
```

There are no mandatory third-party services. Everything required runs on the
Host's machine(s).

## 2. Containers (Level 2)

```
                         Internet
                             │
              ┌──────────────┴───────────────┐
              │                              │
        443/tcp (HTTPS,WSS)        UDP media + TURN
              │                              │
        ┌─────▼─────┐                  ┌─────▼──────┐
        │   Caddy   │                  │  LiveKit   │
        │ TLS, rev. │──/livekit ws────▶│  server    │
        │   proxy   │                  │ (SFU+TURN) │
        └─────┬─────┘                  └──┬───┬─────┘
              │                    webhooks│   │ Redis (optional,
        ┌─────▼──────────┐◀───────────────┘   │  required for
        │  App server    │   token mint, room │  egress/multinode)
        │ (Node/TS)      │──── admin API ────▶│
        │  - REST        │                 ┌──▼───┐
        │  - WS gateway  │                 │Redis │ (optional)
        │  - feature     │                 └──────┘
        │    modules     │
        └──┬──────────┬──┘
           │          │
     ┌─────▼───┐  ┌───▼─────────┐
     │ SQLite/ │  │ Storage:    │
     │ Postgres│  │ local / S3  │
     └─────────┘  └─────────────┘

 Optional: LiveKit Egress (recording), Prometheus/Grafana
```

| Container | Responsibility | Tech | Required |
|---|---|---|---|
| **Caddy** | TLS termination (auto certs), reverse proxy, serves static web client | Caddy 2 | Yes (or any proxy) |
| **App server** | Auth, REST API, WebSocket gateway, text chat, presence, permission checks, token minting, LiveKit webhook handling | Node + TypeScript | Yes |
| **LiveKit server** | SFU: media routing, simulcast, dynacast, data channels, built-in TURN | Go (upstream) | Yes |
| **Database** | Users, channels, messages, roles, invites, audit | SQLite (Postgres adapter post-v1, 18 T32) | Yes |
| **Object storage** | Attachments, avatars | Local disk (S3 adapter post-v1) | Yes |
| **Redis** | Required by LiveKit for Egress or multi-node; app pub/sub across nodes needs the post-v1 Redis adapter | Redis | Optional |
| **LiveKit Egress** | Recording/compositing | Upstream | Optional module |
| **Clients** | UI, local audio processing, WebRTC | React + Electron | Yes |

**Key property:** the app server never touches media. It authorises, then hands
the client a short-lived LiveKit token. Media flows client ⇄ LiveKit directly.

## 3. Planes

Thinking in three planes keeps responsibilities clean.

| Plane | Carries | Path | Failure impact |
|---|---|---|---|
| **Control** | Auth, REST, permissions, token minting | Client → Caddy → App server | No login/join; existing calls continue |
| **Realtime data** | Messages, presence, typing, state events | Client ⇄ App server WebSocket | Text stale; voice unaffected |
| **Media** | Audio, video, screenshare | Client ⇄ LiveKit (UDP, TCP, TURN) | Calls drop; text unaffected |

The planes fail independently. Voice keeps working if the app server restarts,
as long as tokens are still valid and LiveKit is up. Encrypted calls keep their
keys too, because the E2EE room session lives in the LiveKit room, not in app
memory (10 §4.1).

## 4. Key flows

### 4.1 Sign-in and connect
1. Client POSTs credentials to `/api/auth/login`; receives a session token
   (opaque, stored server-side hashed).
2. Client calls `GET /api/v1/capabilities` to learn enabled features and server version.
3. Client opens WebSocket `/gateway`, authenticates with the session token,
   receives `READY` (user, spaces/channels visible, presence snapshot, unread state).
4. Gateway keeps the socket live; client resumes after drops via sequence number.

### 4.2 Send a text message
1. Client sends `message.create` over the gateway (or REST fallback).
2. Server validates permission, sanitises, writes to DB (transaction), assigns ID.
3. Server publishes `message.created` on the internal event bus.
4. Pub/sub adapter fans out to all gateway nodes; each pushes to authorised, subscribed sockets.

### 4.3 Join a voice channel
1. Client sends `voice.join {channelId}` (REST or gateway).
2. Server checks `CONNECT` permission, creates the LiveKit room if it does not
   exist yet (its room ID salts the E2EE key, 10 §4.1), and mints a LiveKit JWT
   scoped to room `vc_<channelId>` with grants (publish audio, subscribe; publish
   video only if permitted), TTL minutes.
3. Server returns `{url, token, e2eeKeyInfo?}`.
4. Client connects to LiveKit using `livekit-client`, publishes mic track
   (after local audio pipeline, see 09).
5. LiveKit webhook `participant_joined` reaches the app server, which updates
   the presence store and broadcasts `voice.state` to every client that can see
   that channel. (Sidebar shows the participant.)

### 4.4 Start a screenshare
1. Client (already connected to the room) calls `getDisplayMedia` (web) or the
   Electron source picker (desktop), publishes a screen track with simulcast
   layers per the chosen preset.
2. LiveKit announces the track to other participants; the app server learns via
   webhook `track_published` and updates presence (so the sidebar can show a
   "live" indicator).
3. Viewers click to watch → client subscribes to that track at the layer
   matching the displayed size (adaptive stream). Publisher upload is unchanged
   by number of viewers; dynacast pauses unused layers.

### 4.5 Leave / disconnect
Explicit leave or LiveKit's participant-disconnected webhook (timeout) clears
presence. A periodic reconciliation job asks LiveKit's RoomService for actual
participants and repairs drift if a webhook was missed. The same job re-checks
every participant's permissions and removes or downgrades anyone who no longer
qualifies, so a ban or role change whose first attempt failed is enforced within
one pass (05 §6.3).

## 5. Deployment topologies

| Topology | Description | When |
|---|---|---|
| **A. Single box (default)** | Compose stack: Caddy, app, LiveKit, SQLite file, local storage. No Redis. | 99% of users |
| **B. Single box + recording** | Adds Redis and LiveKit Egress | Hosts wanting recordings |
| **C. Split media** | App on one host, LiveKit on a bandwidth-rich host | Weak home server, big VPS pipe |
| **D. Multi-node** | Postgres, Redis, 2+ app nodes, 2+ LiveKit nodes | Out of scope for v1; needs the post-v1 Postgres and Redis adapters |

B and C are config changes. D needs the Postgres and Redis adapters, which are
post-v1 (18 T32); the DB/pubsub/storage ports keep that an adapter to write, not
a rewrite.

## 6. Cross-cutting architectural principles

1. **Control/media separation.** App server stays out of the media path.
2. **Modular monolith.** One process, feature modules; no microservices.
3. **Ports where a real alternative exists.** DB, storage, pubsub, auth. Not media.
4. **Server is authoritative.** Clients are untrusted; every action is permission-checked server-side; client UI hiding is cosmetic.
5. **Events over imports.** Features communicate through the internal event bus, not by importing each other.
6. **Capabilities, not versions.** Clients adapt to `/capabilities`, not by sniffing server version.
7. **Config-driven.** One validated config; the resolved module graph is printed at boot.
8. **Fail soft.** Loss of Redis/LiveKit/webhooks degrades features, never corrupts data.
9. **Secure by default.** Invite-only, TLS, E2EE on for voice where enabled.
10. **Privacy by default.** No telemetry, no third-party calls unless configured.

## 7. Technology summary

| Concern | Choice |
|---|---|
| Language | TypeScript (server, shared, client) |
| Server framework | Fastify (ADR-005) |
| Realtime | WebSocket gateway, JSON messages, sequence + resume |
| ORM/query | Kysely on better-sqlite3 (ADR-007) |
| Media | LiveKit (server + `livekit-client`) |
| Client UI | React, Vite, Zustand, Tailwind |
| Desktop | Electron |
| Reverse proxy | Caddy |
| Packaging | Docker Compose; electron-builder installers |
| Monorepo | pnpm workspaces |

## 8. Repository layout (target)

```
D:\SelfHostedChat
├─ docs/                      ← these documents
├─ apps/
│  ├─ server/                 app server + feature modules
│  ├─ web/                    React client
│  └─ desktop/                Electron shell
├─ packages/
│  ├─ shared/                 types, protocol, zod schemas, permissions
│  ├─ db/                     schema, migrations, sqlite driver (pg post-v1)
│  ├─ storage/                local adapter (s3 post-v1)
│  ├─ pubsub/                 memory adapter (redis post-v1)
│  ├─ auth/                   local + oidc adapters
│  └─ audio/                  client audio pipeline (worklets, denoiser)
└─ deploy/
   ├─ docker-compose.yml
   ├─ Caddyfile
   └─ livekit.yaml
```

## Open items
- ~~Confirm Fastify vs Hono~~ Resolved: Fastify (ADR-005, 18 T1).
- Confirm whether the web client is served by Caddy as static files or by the app server (leaning Caddy).
- ~~UDP strategy~~ Resolved: single mux port 7882 plus TCP 7881 (08 §3.2; confirm in spike D6).
