# 05. Server Internals

How the app server is built inside: process model, layers, ports and adapters,
gateway, LiveKit integration, jobs, errors, and operational behaviour.
Wire formats are in 07; schema in 06; permissions in 11.

## 1. Process model

- **One Node.js process** for HTTP, WebSocket and background jobs (v1).
- CPU-heavy work (image thumbnails, avatar resize) runs in `worker_threads` or via `sharp` (native, off-thread).
- State that must be shared between processes (presence, rate-limit counters, pub/sub) goes through the **pubsub port**, so a second process needs only the (post-v1) Redis adapter.
- Graceful shutdown: stop accepting connections, send WS `RECONNECT` hint, flush in-flight writes, close DB. SIGTERM timeout 15 s.
- Clustering (multiple app nodes) needs the Postgres and Redis adapters, which are post-v1 (18 T32). The ports keep it possible; v1 neither ships nor tests it.

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
 adapters      sqlite · local-fs · memory · local · oidc   (postgres · s3 · redis: post-v1)
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
SQLite specifics: WAL, `synchronous=NORMAL`, `busy_timeout=5000`, one write connection (serialised), `foreign_keys=ON`. better-sqlite3 runs every statement on the calling thread, so in v1 the database shares the event loop with HTTP, the gateway and jobs. Rules: no full `VACUUM` and no `VACUUM INTO` on the live process; backups use the incremental `.backup()` API; search queries are bounded (`LIMIT` plus a cost cap). If spike D5 measures unacceptable blocking, the database moves to a worker thread (18 T28). Postgres (post-v1 adapter): pooled connections, `statement_timeout`.

**Outbox.** A use case that feeds derived data appends a row to the core-owned `outbox` table (06 §3.14) inside its own transaction. The core `outbox.drain` job delivers rows in ID order to the subscribed module and deletes each row only after its handler succeeds; handlers are idempotent, so redelivery after a crash is safe. In v1 the only consumer is the search index (06 §3.9, 18 T29).

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
Local adapter (v1): files under a configured directory sharded by key prefix; path traversal-safe key validation; `signedUrl` returns null, so files are served by the app with session auth. The desktop app authenticates `<img>` and other subresource requests by having the Electron main process add the `Authorization` header for the instance origin (13 §3, 18 T31). S3 adapter (post-v1): presigned URLs.

### 3.3 PubSub port
```ts
interface PubSub {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(topic: string, handler: (p: unknown) => void): Unsubscribe;
  // ephemeral shared state for presence/rate limits:
  kv: { get; set; del; incr; expire; sadd; srem; smembers };
}
```
Memory adapter (v1): in-process maps, lost on restart. Redis adapter (post-v1): pub/sub + keys with TTL. Nothing that must survive an app restart lives in `kv`; E2EE room state lives in the LiveKit room (10 §4.1).

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
- One LiveKit room per voice channel: name `vc_<channelId>`. On the first join to an empty channel the app creates the room explicitly (`RoomService.createRoom` with `emptyTimeout` and `maxParticipants`) before minting the token, because the room's ID salts the E2EE key (10 §4.1, 18 T27).
- The app is the **only** issuer of tokens; clients never hold API keys.

### 6.2 Token minting
Claims (LiveKit `VideoGrant`): `room`, `roomJoin`, `canSubscribe`, `canPublish`, `canPublishData`, `canPublishSources` (subset of `microphone`, `camera`, `screen_share`, `screen_share_audio` according to the user's permissions), `canUpdateOwnMetadata`. `identity` = user ID (stable), `name` = display name, `metadata` = small JSON (avatar hash, etc.). TTL short (e.g. 10 min). The TTL limits reuse of a leaked token; it is **not** a revocation mechanism, because LiveKit may refresh tokens for connected participants itself (verify in D1). Revocation is enforced through `RoomService` (§6.4) and the reconciler (§6.3). The app re-checks permissions whenever it mints a token, including on `POST /voice/channels/:id/token`.

### 6.3 Webhooks
- Endpoint `/api/internal/livekit/webhook`, verified with LiveKit's webhook receiver (signature header; API secret). Not exposed through Caddy to the public beyond what is needed; allow-list the LiveKit host where possible.
- Handled events: `participant_joined`, `participant_left`, `track_published`, `track_unpublished`, `room_finished`.
- Handlers are idempotent; each updates the presence store and emits bus events (`voice.participant.joined` …).
- **Reconciliation job** every 30 s (configurable): `RoomServiceClient.listRooms/listParticipants` vs presence store; repair drift (missed webhooks, app downtime).
- The same job reconciles **authorisation**: for every participant it recomputes CONNECT/SPEAK/VIDEO/SCREEN_SHARE from the DB, calls `removeParticipant` or `updateParticipant` on any mismatch, and rotates the room's E2EE key if anyone was removed. When the event-driven path fails (LiveKit call timed out, app restarted mid-propagation), enforcement still lands within one interval (18 T25). Every repair is counted (`reconcile_repairs_total{kind}`, §8).

### 6.4 Server-initiated media actions
Using `RoomServiceClient`: remove participant (kick/ban), mute published track (server-mute), update participant permissions (e.g. revoke screenshare mid-call), move user (remove + instruct client to join another room).

### 6.5 Config and defaults owned by the server
Per-channel voice settings (bitrate cap, max participants, video allowed) live in the DB and are applied when minting tokens or via room update. Client-side encoding defaults (simulcast layers, presets) are sent in `/capabilities` and the join response so Hosts can tune centrally (08).

## 7. Background jobs

Tiny internal scheduler (no external queue): interval and cron-ish jobs with jitter, overlap protection, and per-job metrics. On multi-node, a lease in `pubsub.kv` ensures one runner.

| Job | Frequency | Purpose |
|---|---|---|
| `presence.reconcile` | 30 s | Sync LiveKit participants with presence and permissions (§6.3) |
| `outbox.drain` | continuous (short poll) | Deliver outbox rows to derived-data handlers (§3.1) |
| `sessions.purge` | hourly | Delete expired sessions |
| `invites.purge` | hourly | Delete expired/used-up invites |
| `uploads.gc` | daily | Remove orphaned files (no referencing message, > 24 h) |
| `messages.retention` | daily | Optional message retention policy |
| `db.maintenance` | weekly | SQLite `PRAGMA optimize` and `incremental_vacuum`; never a full `VACUUM` (§3.1) |
| `backup.hook` | configurable | Optional scheduled DB snapshot via the incremental backup API (§3.1) |

## 8. Errors, logging, metrics

- Domain errors are typed (`class AppError { code; httpStatus; safeMessage }`); everything else is logged with a request ID and returned as `INTERNAL`.
- pino JSON logs; levels per module; redaction of tokens, passwords, cookies, `Authorization`. The request ID is carried into bus events and outbox rows, so a handler's log line names the request that triggered it (18 T34).
- Metrics (if `metrics` enabled): HTTP latency/error counters, WS connections, events/s, queue depth, DB latency, job durations, voice participants per room, webhook lag, outbox backlog, and reconciler repairs by kind (`reconcile_repairs_total{kind}`). A reconciler that quietly fixes drift hides a broken primary path such as webhooks, so a sustained non-zero repair rate is an alert (14 §8).
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
