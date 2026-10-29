# 07. API & Realtime Protocol

Two interfaces: a REST API for request/response operations and a WebSocket
gateway for server-pushed events and low-latency commands. Media is separate
(LiveKit, see 08). Server internals are in 05, schemas in 06, permission names in 11.

## 1. Principles

- REST is the source of truth for state changes; the gateway pushes the results as events. Clients MAY send a few latency-sensitive commands over the gateway (typing, presence, voice state) but message creation is REST-first so it is trivially retryable and testable.
- All bodies JSON (UTF-8), except uploads (multipart).
- Every enabled module owns its routes and events; disabled modules return `404`/`FEATURE_DISABLED`.
- Versioning: URL prefix `/api/v1`, plus an integer `apiVersion` in `/capabilities` and in the gateway `HELLO`. Additive changes (new fields, new events, new optional params) do not bump the version. Clients MUST ignore unknown fields and unknown events.
- Idempotency: `POST /channels/:id/messages` accepts a client-generated `nonce` (string, ≤ 64 chars). Within 5 minutes the same `nonce` from the same user returns the original message rather than creating a duplicate.
- IDs are ULID strings; timestamps in responses are ISO-8601 UTC strings; bitsets are decimal strings.
- OpenAPI 3.1 is generated from the route schemas and published at `/api/v1/openapi.json` (dev and optionally prod).

## 2. Conventions

### 2.1 Authentication
`Authorization: Bearer <session token>` on all authenticated requests and in the gateway `IDENTIFY`. The web client MAY alternatively use an HttpOnly, SameSite=Strict, Secure cookie (a CSRF token header is then required on state-changing requests). See 11.

### 2.2 Error envelope
```json
{ "error": { "code": "PERMISSION_DENIED", "message": "You cannot do that.", "details": { "missing": "SEND_MESSAGES" } } }
```
| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `BAD_REQUEST` |
| 401 | `UNAUTHENTICATED`, `SESSION_EXPIRED` |
| 403 | `PERMISSION_DENIED`, `FEATURE_DISABLED`, `BANNED`, `TIMED_OUT`, `ACCOUNT_DISABLED`, `SETUP_REQUIRED` (instance not yet initialised, 11 §1.4) |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` (username taken, etc.) |
| 410 | `INVITE_EXPIRED`, `INVITE_EXHAUSTED` |
| 413 | `PAYLOAD_TOO_LARGE`, `QUOTA_EXCEEDED` (per-user upload quota, 06 `attachment`) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 426 | `CLIENT_TOO_OLD` (api version mismatch) |
| 429 | `RATE_LIMITED` (with `retryAfterMs`) |
| 500/503 | `INTERNAL`, `UNAVAILABLE` (e.g. LiveKit down for voice join) |

`message` is safe for display; `code` is stable and used for logic and i18n lookup.

### 2.3 Pagination
Cursor-based by ID: `?before=<id>&limit=50` (default 50, max 100), `?after=`, `?around=`. Responses are arrays ordered ascending by ID. Lists that are not ID-ordered return `{items, nextCursor}`.

### 2.4 Rate limits
Headers on every response: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`. Route classes (defaults, configurable):

| Class | Limit |
|---|---|
| auth (login/register) | 10 / 15 min per IP, 5 / 15 min per username |
| message create | 10 / 10 s per user per channel (slowmode may lower) |
| message edit/delete | 20 / 10 s per user |
| uploads | 10 / min per user |
| read endpoints | 120 / min per user |
| voice join | 10 / min per user |
| typing | 1 / 3 s per channel (silently coalesced) |

## 3. REST API

### 3.1 System (always on)
| Method & path | Purpose |
|---|---|
| GET `/capabilities` | Feature flags, limits, auth methods, API version, source-code URL (AGPL) |
| GET `/healthz`, `/readyz` | Liveness / readiness |
| GET `/metrics` | Prometheus text (module `metrics`, restricted by IP/token) |
| POST `/internal/livekit/webhook` | LiveKit webhook receiver (signature-verified; not for clients) |

### 3.2 Auth & sessions (module `accounts`, `invites`)
| Method & path | Purpose |
|---|---|
| POST `/auth/setup` | First-run only: create owner (requires setup token, see 11) |
| POST `/auth/register` | Register with `inviteCode` (or open signup if enabled) |
| POST `/auth/login` | Username + password → `{token, expiresAt, user}` |
| POST `/auth/logout` | Revoke current session |
| GET `/auth/sessions` · DELETE `/auth/sessions/:id` | List / revoke sessions |
| POST `/auth/password` | Change password (requires current) |
| POST `/auth/reset` | Redeem an admin-issued one-time code `{code, newPassword}`; revokes all of the user's sessions; rate-limited like login (11 §1.6) |
| GET `/auth/oidc/start` · GET `/auth/oidc/callback` | OIDC flow (if enabled) |
| GET `/invites/:code` | Public invite preview (instance name, member count) |

> **As built in M1.** Paths are under `/api/v1`. Added: `POST /auth/setup/verify` (checks the setup token, 204), `POST /auth/gateway-ticket` (`{ticket, expiresInMs}`), `GET/PATCH /admin/instance` (owner). `IDENTIFY` and `RESUME` take `ticket` instead of `token` for cookie sessions. `READY` is sent with `s: 0`; sequence numbers of later events start at 1. `/capabilities` also carries `server.sourceUrl` and `auth.setupRequired`. Probes `/healthz` and `/readyz` are at the root, not under `/api/v1`, and Caddy does not proxy them. Not built yet: `register`, `reset`, `PATCH /users/@me`, settings, avatars, OIDC.

> **As built in M2.** Differences from the tables above:
> - **Visibility answers.** A channel the caller cannot view answers `404 NOT_FOUND` on every channel route, like a channel that does not exist; a channel they can view but lack a permission in answers `403` with `details.missing`. `GET /channels` returns `{categories, channels, permissions}` where `permissions` maps each visible channel to the caller's effective bits (cosmetic). Archived channels appear only to `MANAGE_CHANNELS` with `?archived=true`.
> - **Members and roles.** `GET /members` returns `{items, nextCursor}` (limit ≤ 200). `GET /members/:id/permissions?channelId=` (MANAGE_ROLES) returns the effective bits and every step of 11 §2.3. Roles keep contiguous positions 1..n above `@everyone` (0); `position` in a create or patch is the place to insert at. Overwrites are edited under `/channels/:id/overwrites…` (module `channels`, which owns the routes; `roles` owns the table) and `GET` lists them (MANAGE_CHANNELS). Instance-wide bits sent in an overwrite are ignored.
> - **Messages.** Typing is gateway-only (`typing.start`; no REST route, 18 T10). `POST …/messages` answers `201` for a new message and `200` with the original for a repeated `nonce`. `GET …/pins` lists pins. A member without `READ_HISTORY` gets `[]` from history and still receives live events. Mentions are tokens in the content (`<@user>`, `<@&role>`, `<#channel>`, `@everyone`, `@here`); unknown users and roles are dropped, and `@everyone` needs `MENTION_EVERYONE`. Messages carry `author`, `reply` (reference with excerpt) and `attachments`. `DELETE` is soft. The event `MESSAGE_UPDATE` also announces "File removed".
> - **Read state.** `GET /read-state` and `POST /channels/:id/ack` return `{channelId, lastReadId, latestMessageId, mentionCount}`. An ack never moves back and is clamped to the newest message. `READY.readState` is an array of these.
> - **Uploads.** `GET /files/:id/:filename[?thumb=1]` (cookie or bearer), `PUT/DELETE /users/@me/avatar`, `GET /avatars/:name` (immutable, per-version name), `GET /users/@me/attachments` returns `{items, nextCursor}`, `GET /users/@me/storage`. Files are served without a `Content-Length` (chunked): setting it hung server shutdown in the test (see 18 §I). Images get a 512 px WebP thumbnail; avatars are cropped to 256 px.
> - **Accounts.** `POST /auth/register`, `POST /auth/reset`, `POST /admin/users/:id/reset-token`, `PATCH /users/@me`, `GET/PATCH /users/@me/settings` (PATCH is all or nothing; a `null` value clears a key and travels as `null` in `USER_SETTINGS_UPDATE`). Synced keys in M2: `appearance.theme|accent|density`, `locale`, `notifications.default`, `notifications.channel.<id>` (`{level?, mutedUntil?}`).
> - **Invites.** `GET /invites?all=&include=` (own, or everyone's with MANAGE_INVITES), `POST /invites`, `DELETE /invites/:id`, public `GET /invites/:code`. A default role needs MANAGE_ROLES and the same rank rules as assigning it.
> - **READY** now also carries `permissions`, `channelPermissions`, `roles`, `members`, `categories`, `channels`, `presence`, `settings` and `readState`. Events built: `CHANNEL_CREATE|UPDATE|DELETE|REORDER`, `CATEGORY_*`, `ROLE_*`, `MEMBER_ADD|UPDATE`, `USER_UPDATE`, `PRESENCE_UPDATE`, `PERMISSIONS_UPDATE`, `USER_SETTINGS_UPDATE`, `MESSAGE_CREATE|UPDATE|DELETE|PIN`, `TYPING_START`, `READ_STATE_UPDATE`. Not built: `SESSION_REPLACED`, `INSTANCE_UPDATE`, `MEMBER_REMOVE`, reactions, moderation events, `GET /search` `before`/`after` filters, OpenAPI output.

### 3.3 Users & members
| Method & path | Purpose |
|---|---|
| GET `/users/@me` · PATCH `/users/@me` | Profile |
| GET `/users/@me/settings` · PATCH `/users/@me/settings` | Synced preferences as `{key: value}` (06 `user_setting`); unknown keys rejected; last-writer-wins |
| PUT `/users/@me/avatar` · DELETE | Avatar upload (uploads module) |
| GET `/members` | Member list (paged) with roles |
| GET `/members/:userId` | Single member |
| PATCH `/members/@me` | Own nickname |
| PATCH `/members/:userId` | Nickname / roles (permission-gated) |

### 3.4 Roles & permissions (module `roles`)
| Method & path | Purpose |
|---|---|
| GET/POST `/roles` · PATCH/DELETE `/roles/:id` | Role CRUD, reorder via `position` |
| PUT/DELETE `/members/:userId/roles/:roleId` | Assign / remove |
| PUT/DELETE `/channels/:id/overwrites/:type/:targetId` | Per-channel overwrites |

### 3.5 Channels (module `channels`)
| Method & path | Purpose |
|---|---|
| GET `/channels` | Visible channels + categories (permission-filtered) |
| POST `/channels` · PATCH/DELETE `/channels/:id` | CRUD (MANAGE_CHANNELS) |
| POST/PATCH/DELETE `/categories` | Category CRUD |
| PATCH `/channels/reorder` | Bulk position update |

### 3.6 Text (module `text-chat` and satellites)
| Method & path | Purpose |
|---|---|
| GET `/channels/:id/messages` | History (before/after/around) |
| POST `/channels/:id/messages` | Create `{content, replyToId?, attachmentIds?, nonce}` |
| PATCH `/channels/:id/messages/:mid` | Edit own message |
| DELETE `/channels/:id/messages/:mid` | Delete own / any with MANAGE_MESSAGES |
| PUT/DELETE `/channels/:id/pins/:mid` | Pin / unpin |
| PUT/DELETE `/channels/:id/messages/:mid/reactions/:emoji/@me` | Reactions (module `reactions`) |
| POST `/channels/:id/typing` | Typing hint (also available via gateway) |
| POST `/channels/:id/ack` | Mark read up to `{messageId}`; never moves the read position backwards (module `read-state`, 06 §3.8) |
| GET `/search` | `q`, optional `channelId`, `authorId`, `before`, `after`, paged (module `search`) |

### 3.7 Uploads (module `uploads`)
| Method & path | Purpose |
|---|---|
| POST `/uploads` | `multipart/form-data` single file → `{id, filename, contentType, size, width?, height?}`; attached later by ID in message create |
| GET `/users/@me/attachments` | Own non-deleted attachments for Settings → Storage: `sort=size` or `sort=date`, cursor-paginated → `[{id, filename, contentType, size, channelId?, messageId?, createdAt}]`. Channel and message IDs are included only where the user can still view the channel (design U16) |
| DELETE `/uploads/:id` | Delete an own attachment: sets `deleted_at`, frees quota at once, and the message shows "File removed" (design U16) |
| GET `/files/:id/:filename` | Download/serve. Auth required: cookie on web; on desktop the Electron main process adds the `Authorization` header, so `<img>` and other subresources work (13 §3). Signed URLs only with the post-v1 S3 adapter |
Quota: the sum of a user's non-deleted attachment sizes must stay under `uploads.userQuotaBytes`, otherwise `QUOTA_EXCEEDED`; `GET /users/@me/storage` returns `{usedBytes, quotaBytes}` and the UI shows it in settings. Rules: size limit from config, extension and content-sniff checks, images get dimensions + generated thumbnail. Files served with `nosniff`; non-image types served as attachment. See 05 §9.

### 3.8 Voice (modules `voice`, `video`, `screenshare`, `voice-e2ee`)

> **As built in M3.** `POST /voice/channels/:id/join` returns `{url, token, expiresAt, roomName, publishDefaults:{audioBitrateKbps, dtx, red, sources, video:{cameraMaxKbps, screenshareMaxKbps}}, userLimit}` (M4: the video caps are the server-wide `voice.camera.maxBitrateKbps` and `voice.screenshare.maxBitrateKbps`, the screen one lowered by the channel setting `maxScreenshareKbps`; advisory, because LiveKit cannot enforce a publisher's bitrate), no `e2ee` yet (M5); a hidden or missing channel answers 404, a full one 409 with `details.reason = channel_full`. `POST /voice/leave`, `GET /voice/state` and `GET /voice/status` (needs MANAGE_INSTANCE; webhook and reconciler counters) exist. Added: `POST /voice/diagnostics` hands out a 60 s listen-only token for a private room `diag_<userId>` that never shows as presence (the connection test, 08 §10). Not built: `/voice/channels/:id/token` (LiveKit refreshes tokens, D1), `e2ee-key`, `members/:userId/mute|move|disconnect` (M5). `VOICE_STATE_UPDATE` carries `{channelId, userId, joined, participant?}`; `VOICE_SERVER_DISCONNECT` reasons used: `moved`, `permission_lost`, `channel_deleted`.
| Method & path | Purpose |
|---|---|
| GET `/voice/state` | Snapshot: for each visible voice channel, participants and their published sources |
| POST `/voice/channels/:id/join` | → `{url, token, expiresAt, publishDefaults, e2ee?: {keyIndex, key (base64), epoch}}` |
| POST `/voice/channels/:id/token` | Refresh token for an existing session |
| GET `/voice/channels/:id/e2ee-key` | Re-fetch the current E2EE key and epoch (after a missed rekey; 10 §8) |
| POST `/voice/leave` | Explicit leave (also revokes server-side presence immediately) |
| POST `/voice/members/:userId/mute` | Server-mute (MUTE_MEMBERS) |
| POST `/voice/members/:userId/move` | Move to another channel (MOVE_MEMBERS) |
| POST `/voice/members/:userId/disconnect` | Disconnect (MOVE_MEMBERS) |

### 3.9 Moderation & audit
| Method & path | Purpose |
|---|---|
| POST `/members/:userId/kick` | Kick |
| PUT `/bans/:userId` · DELETE | Ban / unban |
| PUT `/members/:userId/timeout` | `{until}` |
| GET `/audit-log` | Paged, filter by actor/action |

### 3.10 Admin
| Method & path | Purpose |
|---|---|
| GET `/admin/modules` | Resolved module graph, adapters, warnings |
| GET/PATCH `/admin/instance` | Name, icon, signup policy (non-module settings) |
| GET/PATCH `/admin/uploads` | Largest file and per-person upload space, changeable at runtime (owner; 18 §L) |
| GET/PATCH `/admin/voice` | Server-wide camera and screen share bitrate caps, changeable at runtime (owner; 18 §L) |
| POST `/admin/users/:id/reset-token` | Generate a one-time password-reset code (11 §1.6) |
| GET `/admin/stats` | User/message counts, storage use, voice usage |

## 4. WebSocket gateway

Endpoint: `wss://<host>/gateway?v=1&encoding=json`. (Optional `compress=zstd`
or per-message deflate later; not v1.)

### 4.1 Frame format
```json
{ "op": 0, "t": "MESSAGE_CREATE", "s": 1423, "d": { ... } }
```
- `op` integer opcode, `t` event name (only for `op 0` dispatch), `s` sequence (only on dispatch), `d` payload.
- Max frame: 64 KiB client→server, 1 MiB server→client.

### 4.2 Opcodes
| op | Name | Dir | Meaning |
|---|---|---|---|
| 0 | DISPATCH | S→C | An event; carries `t`, `s` |
| 1 | HEARTBEAT | both | Client sends with last `s`; server may request |
| 2 | IDENTIFY | C→S | `{token, client: {name, version, platform}, capabilitiesHash?}` |
| 3 | RESUME | C→S | `{token, sessionId, lastSeq}` |
| 4 | COMMAND | C→S | `{cmd, args, id}` for gateway commands (typing, presence, voice-state) |
| 5 | COMMAND_RESULT | S→C | `{id, ok, error?}` |
| 7 | RECONNECT | S→C | Server asks client to reconnect and resume (deploy, rebalance) |
| 9 | INVALID_SESSION | S→C | `{resumable: bool}`; if false, do full IDENTIFY |
| 10 | HELLO | S→C | `{heartbeatIntervalMs, apiVersion, sessionHint}` |
| 11 | HEARTBEAT_ACK | S→C | |

### 4.3 Lifecycle
1. Client connects → server sends `HELLO`.
2. Client sends `IDENTIFY` within 10 s (else close `4003`).
3. Server validates token, creates a gateway session, sends dispatch `READY`.
4. Heartbeats every `heartbeatIntervalMs` (default 25 s with jitter). Missing two acks → client reconnects; missing client heartbeats for 2 intervals → server closes.
5. On drop, client reconnects with exponential backoff (1 s → 30 s, jitter) and sends `RESUME`. Server replays events with `s > lastSeq` from its ring buffer (default last 1000 events / 2 min per session) and dispatches `RESUMED`; otherwise `INVALID_SESSION {resumable:false}`.
6. After a non-resumable reconnect the client re-fetches state via the new `READY` and drops cached state it can no longer trust (e.g. voice presence, unread counts) while keeping message history.

### 4.4 `READY` payload (sketch)
```json
{
  "sessionId": "...", "user": {...}, "permissions": "2199023255551",
  "instance": { "name": "...", "ownerId": "..." },
  "channels": [...], "categories": [...], "roles": [...],
  "members": { "total": 42, "online": [...] },   // paged afterwards via REST
  "presence": { "<userId>": "online|idle|dnd" },
  "voice": { "<channelId>": [ { "userId": "...", "sources": ["mic","screen"], "muted": false, "deafened": false } ] },
  "readState": { "<channelId>": { "lastReadId": "...", "mentionCount": 0 } },
  "capabilities": { ... }
}
```
Large instances page `members`; v1 target (≤ 200 users) sends everything.

### 4.5 Dispatch events
Delivered only to sockets whose user currently has the necessary visibility.

| Module | Events |
|---|---|
| core | `READY`, `RESUMED`, `SESSION_REPLACED`, `INSTANCE_UPDATE` |
| accounts | `USER_SETTINGS_UPDATE` (own synced preferences changed on another device), `USER_UPDATE`, `MEMBER_ADD`, `MEMBER_REMOVE`, `MEMBER_UPDATE`, `PRESENCE_UPDATE` |
| roles | `ROLE_CREATE/UPDATE/DELETE`, `PERMISSIONS_UPDATE` (own effective permissions changed) |
| channels | `CHANNEL_CREATE/UPDATE/DELETE`, `CATEGORY_*`, `CHANNEL_REORDER` |
| text-chat | `MESSAGE_CREATE/UPDATE/DELETE`, `MESSAGE_PIN`, `TYPING_START` |
| reactions | `REACTION_ADD/REMOVE` |
| read-state | `READ_STATE_UPDATE` (multi-device sync) |
| voice | `VOICE_STATE_UPDATE` (`{channelId, userId, joined/left, sources, muted, deafened}`), `VOICE_SERVER_DISCONNECT` (`{reason}`: kicked, moved, joined_elsewhere, e2ee_mode_changed, permission_lost) |
| voice-e2ee | `E2EE_KEY_UPDATE` (`{channelId, keyIndex, key, epoch}`, only to current participants; 10 §4) |
| moderation | `MEMBER_BAN`, `MEMBER_KICK` (to admins), `YOU_WERE_KICKED` (to target before disconnect) |
| uploads | none (upload completes via REST) |

### 4.6 Gateway commands (op 4)
| cmd | args | Notes |
|---|---|---|
| `presence.set` | `{status: online|idle|dnd|invisible, customStatus?}` | Rate limited |
| `typing.start` | `{channelId}` | Equivalent to REST typing; preferred |
| `voice.state` | `{muted, deafened}` | Declares self-state so others see icons; actual audio muting is client-side + LiveKit track mute |
| `subscribe.channel` | `{channelId}` | Reserved for future lazy subscriptions on large instances; no-op in v1 |

### 4.7 Close codes
| Code | Meaning | Client action |
|---|---|---|
| 1000/1001 | Normal / going away | Reconnect with resume |
| 4000 | Unknown error | Reconnect, resume |
| 4001 | Invalid opcode / malformed | Fix client; do not loop |
| 4002 | Decode error | |
| 4003 | Not authenticated (no IDENTIFY in time) | Re-identify |
| 4004 | Authentication failed / session revoked | Go to login |
| 4005 | Already authenticated | |
| 4007 | Invalid sequence | Full re-identify |
| 4008 | Rate limited | Back off |
| 4009 | Session timed out | Re-identify |
| 4010 | Slow consumer (send queue overflow) | Reconnect, resume |
| 4011 | Client too old (api version) | Show upgrade prompt |
| 4012 | Session replaced (policy: optional single-session mode) | Inform user |

### 4.8 Multiple devices
A user may hold several gateway sessions (desktop + phone browser). All receive
their own events; `READ_STATE_UPDATE` and own `PRESENCE_UPDATE` sync them. For
voice, one LiveKit identity can only be in one place: joining from a second
device replaces the first (the first receives `VOICE_SERVER_DISCONNECT`
`{reason: "joined_elsewhere"}`).

## 5. Ordering and consistency guarantees

- Within one gateway session, events arrive in `s` order.
- A REST write that returns success has been committed before its event is published; clients MUST apply REST responses idempotently (message IDs make this easy) because the gateway event may arrive before or after the REST response.
- Optimistic UI: the client shows the message with its `nonce` immediately, then reconciles when the server message with the same `nonce` arrives (REST response or `MESSAGE_CREATE`).
- Edits and deletes are last-writer-wins; events carry `editedAt` so out-of-order arrival is resolved by timestamp.
- Voice presence is eventually consistent (webhook + reconciliation, 05 §6.3); clients also trust the LiveKit client's own participant list for the room they are in.
- Search results follow commits through the outbox (06 §3.14) and can trail a new message briefly; unread state and mention counts are computed from committed rows (06 §3.8).

## 6. Version negotiation

- Client sends its supported range in `User-Agent`-style header `X-TinCan-Client: name/version api=1-2` and in `IDENTIFY`.
- Server answers `426 CLIENT_TOO_OLD` / close `4011` if the client range excludes the server's `apiVersion`.
- Desktop auto-update (13) keeps clients current; the web client always matches the server it is served from.
- Server supports `apiVersion` N and N-1 for one release cycle where practical.

## 7. Security notes specific to the protocol

- Tokens never appear in URLs or logs (gateway token goes in `IDENTIFY`, not the query string).
- All inputs validated by zod schemas generated from the same definitions used for OpenAPI.
- Message content length, attachment count and reaction counts are limited at the schema layer.
- Output encoding: the server never sends pre-rendered HTML; clients render a Markdown subset with an allow-list (12).
- CORS allow-list from config; gateway checks the `Origin` header for browsers (allowed: instance URL, `app://` scheme for desktop, configured dev origins).

## Open items
- Compression for gateway (zstd/deflate): defer until measured.
- Whether to expose a read-only public REST subset for future bots (explicitly not in v1).
- Typing events as gateway-only vs REST also: both listed; pick one before implementation to avoid two code paths (recommend gateway-only).
