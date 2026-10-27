# 05. Server Internals

How the app server is built inside: process model, layers, ports and adapters,
gateway, LiveKit integration, jobs, errors, and operational behaviour.
Wire formats are in 07; schema in 06; permissions in 11.

## 1. Process model

- **One Node.js process** for HTTP, WebSocket and background jobs (v1).
- CPU-heavy work (image thumbnails, avatar resize) runs in `worker_threads` or via `sharp` (native, off-thread).
- State that must be shared between processes (presence, rate-limit counters, pub/sub) goes through the **pubsub port**, so a second process is a config change.
- Graceful shutdown: stop accepting connections, send WS `RECONNECT` hint, flush in-flight writes, close DB. SIGTERM timeout 15 s.
- Clustering (multiple app nodes) is supported by design (Postgres + Redis) but only tested in CI at 2 nodes, not a v1 operating target.

## 2. Layering

```
 transport     HTTP routes · WebSocket gateway · webhook receiver
    │          (parse, authenticate, validate with zod, map errors)
 application   use-cases per module: createMessage, joinVoice, banMember…
    │          (authorise, orchestrate, publish events)
 domain        entities, permission calculation, pure rules
    │
 ports         db · storage · pubsub · auth · livekit(client wrapper)
    │
 adapters      sqlite · postgres · local-fs · s3 · memory · redis · local · oidc
```

Rules:
- Transport never touches the DB; it calls use-cases.
- Use-cases never import transport types; they take plain inputs and an `actor` (authenticated identity + resolved permissions).
- Domain code is pure and unit-testable without I/O (e.g. `computeChannelPermissions(member, channel)`).
- Only adapters import vendor libraries (better-sqlite3, pg, aws-sdk, ioredis, openid-client).
- LiveKit is **not** behind a port (ADR-002). Only `voice`, `video`, `screenshare`, `voice-e2ee` and `recording` modules import `livekit-server-sdk`; wrapped in one thin `LiveKitService` file purely for testability and so credentials/URLs are in one spot.

## 3. Ports (contracts)

Deliberately small. Each has a contract test suite that all adapters must pass.

### 3.1 Database port
Exposes a typed query builder (Kysely/Drizzle instance) plus:
```ts
interface Db {
  query: QueryBuilder;                 // typed builder
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  dialect: "sqlite" | "postgres";
  search: SearchIndex;                 // the only engine-specific helper
  migrate(modules: Migration[]): Promise<void>;
  health(): Promise<void>;
}
interface SearchIndex {
  index(msg: {id, channelId, authorId, text}): Promise<void>;
  remove(id: string): Promise<void>;
  query(q: string, filter: {channelIds: string[]}, page: Cursor): Promise<Hit[]>;
}
```
SQLite specifics: WAL, `synchronous=NORMAL`, `busy_timeout=5000`, one write connection (serialised), N read connections, `foreign_keys=ON`. Postgres: pooled connections, `statement_timeout`.

### 3.2 Storage port
```ts
interface Storage {
  put(key: string, data: Readable, meta: {contentType, size}): Promise<void>;
  get(key: string): Promise<{stream: Readable, meta}>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, ttlSec: number): Promise<string | null>; // null => proxy via app
  exists(key: string): Promise<boolean>;
}
```
Local adapter: files under a configured directory sharded by key prefix; path traversal-safe key validation. S3 adapter: presigned URLs.

### 3.3 PubSub port
```ts
interface PubSub {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(topic: string, handler: (p: unknown) => void): Unsubscribe;
  // ephemeral shared state for presence/rate limits:
  kv: { get; set; del; incr; expire; sadd; srem; smembers };
}
```
Memory adapter: in-process maps. Redis adapter: pub/sub + keys with TTL.

### 3.4 Auth port
```ts
interface AuthAdapter {
  kind: "local" | "oidc";
  begin?(req): Promise<Redirect | Challenge>;      // oidc redirect
  authenticate(input): Promise<Identity | null>;   // credentials or callback
}
interface Identity { provider: string; subject: string; username?: string; email?: string; }
```
`accounts` maps Identity → local user (creating one only if invite/signup policy allows).
Sessions themselves are always created and stored by `accounts`, independent of adapter.

## 4. HTTP layer

- Fastify with JSON schema/zod validation, request IDs, structured logging.
- Versioned prefix `/api/v1`. Breaking changes bump `apiVersion` (04 §7).
- Uniform error envelope: `{ error: { code, message, details? } }`. Codes are stable strings (e.g. `PERMISSION_DENIED`, `RATE_LIMITED`, `FEATURE_DISABLED`, `NOT_FOUND`, `VALIDATION_FAILED`).
- Security headers, strict CORS (only configured origins; the Electron app uses a custom scheme or loads from the instance URL, see 13), body size limits per route.
- Rate limiting via pubsub `kv` (fixed/sliding window) keyed by user + route class and IP for unauthenticated routes. Stricter on login, signup, invite redemption.
- Static web client is served by Caddy (preferred) or by Fastify as fallback.

## 5. WebSocket gateway

Responsibilities: authenticate, track per-connection subscriptions, deliver
events reliably in order, support resume, apply backpressure.

- **Connection lifecycle:** connect → `HELLO` (heartbeat interval) → client `IDENTIFY` with session token → `READY` snapshot → stream of events. Heartbeat ping/pong; server closes silent sockets.
- **Sequence and resume:** every outbound event carries a per-session monotonically increasing `seq`. The server keeps a short ring buffer per session (e.g. last 1000 events or 2 minutes). On reconnect the client sends `RESUME {sessionId, lastSeq}`; if still buffered the gap is replayed, otherwise the server answers `INVALID_SESSION` and the client re-fetches state via `READY`.
- **Subscriptions:** a socket is automatically subscribed to topics it is authorised for: user topic, channels visible to the user, voice presence for visible voice channels. Visibility changes (role change, channel permission edits, kick) trigger resubscription and, when needed, targeted "channel removed" events.
- **Authorisation on delivery:** the gateway filters by the *current* permissions at delivery time, not those at connect time; permission-changing events invalidate cached per-socket visibility sets.
- **Backpressure:** per-socket send queue with a cap; a slow consumer is disconnected with a resumable close code rather than allowed to grow memory unbounded.
- **Typing indicators and other ephemeral signals:** not persisted; rate limited; coalesced.
- **Presence (online/idle/offline):** derived from live sockets; stored in pubsub `kv` with TTL for multi-node correctness.
- **Max message size** and **per-socket op rate limit** enforced.

## 6. LiveKit integration

Lives in modules `voice`, `video`, `screenshare`, `voice-e2ee`, `recording`.

### 6.1 Room model
- One LiveKit room per voice channel: name `vc_<channelId>`. Rooms are created lazily on first join (LiveKit auto-creates; we set `emptyTimeout` and `maxParticipants` via room settings/token).
- The app is the **only** issuer of tokens; clients never hold API keys.

### 6.2 Token minting
Claims (LiveKit `VideoGrant`): `room`, `roomJoin`, `canSubscribe`, `canPublish`, `canPublishData`, `canPublishSources` (subset of `microphone`, `camera`, `screen_share`, `screen_share_audio` according to the user's permissions), `canUpdateOwnMetadata`. `identity` = user ID (stable), `name` = display name, `metadata` = small JSON (avatar hash, etc.). TTL short (e.g. 10 min); the LiveKit client refreshes by asking the app for a new token on `TokenRefresh` events, and the app re-checks permissions each time.

### 6.3 Webhooks
- Endpoint `/api/internal/livekit/webhook`, verified with LiveKit's webhook receiver (signature header; API secret). Not exposed through Caddy to the public beyond what is needed; allow-list the LiveKit host where possible.
- Handled events: `participant_joined`, `participant_left`, `track_published`, `track_unpublished`, `room_finished`.
- Handlers are idempotent; each updates the presence store and emits bus events (`voice.participant.joined` …).
- **Reconciliation job** every 30 s (configurable): `RoomServiceClient.listRooms/listParticipants` vs presence store; repair drift (missed webhooks, app downtime).

### 6.4 Server-initiated media actions
Using `RoomServiceClient`: remove participant (kick/ban), mute published track (server-mute), update participant permissions (e.g. revoke screenshare mid-call), move user (remove + instruct client to join another room).

### 6.5 Config and defaults owned by the server
Per-channel voice settings (bitrate cap, max participants, video allowed) live in the DB and are applied when minting tokens or via room update. Client-side encoding defaults (simulcast layers, presets) are sent in `/capabilities` and the join response so Hosts can tune centrally (08).

## 7. Background jobs

Tiny internal scheduler (no external queue): interval and cron-ish jobs with jitter, overlap protection, and per-job metrics. On multi-node, a lease in `pubsub.kv` ensures one runner.

| Job | Frequency | Purpose |
|---|---|---|
| `presence.reconcile` | 30 s | Sync LiveKit participants with presence |
| `sessions.purge` | hourly | Delete expired sessions |
| `invites.purge` | hourly | Delete expired/used-up invites |
| `uploads.gc` | daily | Remove orphaned files (no referencing message, > 24 h) |
| `messages.retention` | daily | Optional message retention policy |
| `db.maintenance` | weekly | SQLite `PRAGMA optimize`/vacuum, Postgres analyze hints |
| `backup.hook` | configurable | Optional scheduled DB snapshot to storage |

## 8. Errors, logging, metrics

- Domain errors are typed (`class AppError { code; httpStatus; safeMessage }`); everything else is logged with a request ID and returned as `INTERNAL`.
- pino JSON logs; levels per module; redaction of tokens, passwords, cookies, `Authorization`.
- Metrics (if `metrics` enabled): HTTP latency/error counters, WS connections, events/s, queue depth, DB latency, job durations, voice participants per room, webhook lag.
- `/healthz` (process alive), `/readyz` (DB reachable, migrations applied, LiveKit reachable if voice enabled).

## 9. Security-relevant server behaviours (detail in 15)

- Passwords: argon2id with tuned params; per-account login throttling and global rate limits.
- Session tokens: random 256-bit, stored hashed (SHA-256); sent via `Authorization` header for API/WS (desktop and web), with optional HttpOnly SameSite cookie for the web client.
- Authorisation: single `can(actor, permission, resource)` function; no ad hoc checks scattered in handlers.
- Uploads: size limit, content-type sniffing, serve with `Content-Disposition` and `X-Content-Type-Options: nosniff`; user content served from a separate origin or with a strict CSP to prevent same-origin script execution.
- Markdown rendering is client-side with a strict allow-list; server stores raw text only.
- SSRF-safe fetcher for link previews (block private ranges, redirects limited, size/time limits, off by default).

## 10. Dev ergonomics

- `pnpm dev` runs server with an in-memory/SQLite setup and a local LiveKit dev container; seeded sample data command.
- `config check`, `module list`, `db migrate`, `user create`, `invite create`, `backup`, `restore` exposed through a small admin CLI that shares code with the server.
- OpenAPI generated from route schemas for the REST surface (07).

## Open items
- Single process: acceptable for v1? (assumed yes)
- ~~Admin CLI packaging~~ Resolved: `tincan` wraps `node server.js admin …`, one artifact (14 §9).
- ~~Webhook exposure~~ Resolved: `/api/internal/*` is blocked at the proxy; LiveKit reaches the app over the internal network (14 §2.1).
