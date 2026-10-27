# 06. Data Model

Portable across SQLite and Postgres (ADR-007). Notation is engine-neutral;
`id` is a text ULID, `ts` is integer epoch milliseconds (UTC), `bool` is 0/1,
`json` is text containing validated JSON (native JSON column on Postgres where
the adapter chooses to).

## 1. Conventions

- All primary keys are ULID text (time-sortable; used directly for cursor pagination).
- Every module-owned table is prefixed by owner for clarity (e.g. `msg_`, `vc_`) only where ambiguous; otherwise plain names below.
- `space_id` on scoped tables (ADR-015) even though v1 has exactly one space. A default space row is created at first-run.
- Soft delete (`deleted_at`) for user-visible content so moderation and audit remain possible; hard delete job after retention window.
- Foreign keys enforced (`PRAGMA foreign_keys=ON`).
- All timestamps UTC; clients localise.
- Migrations are forward-only, owned by modules, tracked in `_migrations(module, version, applied_at)`.

## 2. Entity overview

```
 space 1─* channel_category 1─* channel 1─* message 1─* attachment
   │                              │            │
   │                              │            ├─* reaction
   │                              │            └─* message_mention
   ├─* role ─* member_role *─ member *─ user
   │     └─* channel_overwrite *─ channel
   ├─* invite
   └─* audit_log
 user 1─* session
 user 1─* read_state *─ channel
 user 1─* ban / timeout (per space)
 voice_presence (ephemeral, not in DB)
```

## 3. Tables

### 3.1 Accounts (module `accounts`)

**user**
| col | type | notes |
|---|---|---|
| id | id | PK |
| username | text | unique, case-insensitive (store lowercase + `display_username`), 2–32 chars |
| display_name | text | |
| avatar_key | text? | storage key, nullable |
| status_text | text? | |
| password_hash | text? | null for OIDC-only accounts |
| created_at | ts | |
| disabled_at | ts? | login blocked |
| is_instance_owner | bool | exactly one at first-run |

**identity** (external auth links)
| id | user_id FK | provider text | subject text | created_at | unique(provider, subject) |

**session**
| col | type | notes |
|---|---|---|
| id | id | |
| user_id | FK | |
| token_hash | text | SHA-256 of opaque token, unique |
| created_at / last_used_at / expires_at | ts | sliding expiry |
| client_name | text | "Desktop Windows 1.0", for the sessions list |
| ip_hash / user_agent | text | coarse, for security display; configurable retention |
| revoked_at | ts? | |

**password_reset** (admin-issued one-time reset codes, 11 §1.6)
| col | type | notes |
|---|---|---|
| id | id | |
| user_id | FK | target account |
| code_hash | text | SHA-256 of the code; the code itself is shown once to the admin |
| created_by | FK user | admin who issued it (or `null` for CLI) |
| created_at / expires_at | ts | expiry default 1 hour |
| used_at | ts? | single use; set atomically on redemption |
Index: `code_hash` unique, `(user_id)`. Purged by `sessions.purge`. At most one active code per user (issuing a new one revokes the old).

**user_setting** (module `accounts`; synced preferences)
| col | type | notes |
|---|---|---|
| user_id | FK | |
| key | text | namespaced, e.g. `notifications.default`, `notifications.channel.<id>`, `appearance.theme`, `locale` |
| value | json | validated against a per-key zod schema registered by the owning module |
| updated_at | ts | last-writer-wins |
PK `(user_id, key)`. Only user-level preferences that should follow the user across devices live here (notification rules, channel mutes, theme, language, status text defaults). **Device-specific settings never sync:** audio devices, denoiser/preset choices, keybinds, hardware acceleration, window state (12 §8).

Ephemeral login state that is **not** stored in the DB: OIDC `state`/PKCE verifier/nonce and invite code carried through the flow live in the pubsub `kv` with a 10-minute TTL; the one-time setup token is a file in `/data` (11 §1.4).

### 3.2 Spaces, members, roles (modules `accounts`, `roles`)

**space** : id, name, icon_key?, created_at, owner_user_id.

**member** : (space_id, user_id) PK, joined_at, nickname?, timeout_until?, invited_by?.

**role** : id, space_id, name, color?, position int (higher = more authority), permissions (bitset stored as decimal text or two ints to avoid 53-bit JS limit; see 11), is_default bool (`@everyone`), is_managed bool.

**member_role** : (space_id, user_id, role_id) PK.

**channel_overwrite** : id, channel_id FK, target_type ('role'|'member'), target_id, allow bitset, deny bitset. unique(channel_id, target_type, target_id).

**ban** : (space_id, user_id) PK, reason?, banned_by, created_at, expires_at?.

### 3.3 Invites (module `invites`)
**invite** : id, space_id, code (unique, 10–12 chars URL-safe random), created_by, created_at, expires_at?, max_uses?, uses int, revoked_at?, default_role_id?.
**invite_use** : invite_id, user_id, used_at (for audit/abuse tracing).

### 3.4 Channels (module `channels`)
**channel_category** : id, space_id, name, position.
**channel** : id, space_id, category_id?, type ('text'|'voice'), name, topic?, position, created_at, archived_at?, `settings json` (type-specific: voice bitrate cap, user limit, video allowed, slowmode secs for text).

### 3.5 Text (module `text-chat`)
**message**
| col | type | notes |
|---|---|---|
| id | id | ULID; ordering key and cursor |
| channel_id | FK | indexed (channel_id, id DESC) |
| author_id | FK user | |
| content | text | raw Markdown, max 4000 chars (configurable) |
| reply_to_id | id? | |
| created_at | ts | derivable from ULID but stored |
| edited_at | ts? | |
| deleted_at | ts? | soft delete; content blanked on hard delete |
| flags | int | bit 0 pinned, bit 1 system message, … |

Index: `(channel_id, id)`; partial/secondary on `(author_id)` for moderation views.
**pin** is a flag on message (v1) to avoid a table.
**message_mention** : message_id, target_type ('user'|'role'|'everyone'), target_id. Used to compute unread-mention counts cheaply.

### 3.6 Attachments (module `uploads`)
**attachment** : id, message_id? (null until message sent, enables orphan GC), uploader_id, storage_key, filename, content_type, size, width?, height?, sha256, created_at, deleted_at?.

### 3.7 Reactions (module `reactions`)
**reaction** : (message_id, user_id, emoji) PK, created_at. `emoji` is a Unicode string (custom emoji deferred).

### 3.8 Read state (module `read-state`)
**read_state** : (user_id, channel_id) PK, last_read_message_id, mention_count int, updated_at.
Unread = channel's latest message id > `last_read_message_id`. Mention count updated on message creation (increment for mentioned users) and reset on ack.

### 3.9 Search (module `search`)
- SQLite: FTS5 virtual table `message_fts(content, channel_id UNINDEXED, message_id UNINDEXED)` kept in sync by module event handlers (`message.created/updated/deleted`) so it never couples to the `text-chat` write path.
- Postgres: generated `tsvector` column or separate `message_search` table with GIN index.
- Search results are filtered by the *current* channel visibility of the caller before return (never index-time permission).

### 3.10 Moderation and audit (modules `moderation`, `audit-log`)
**audit_log** : id, space_id, actor_id, action text (e.g. `member.ban`, `channel.delete`, `role.update`), target_type, target_id, details json, created_at. Append-only; retention configurable.
(Reports/flagging deferred.)

### 3.11 Voice (module `voice`)
Voice **presence is ephemeral** and is not stored in the DB; it lives in the pubsub `kv` (keys with TTL, reconciled against LiveKit every 30 s). Persisted voice data is limited to the channel's `settings` json. Optional later: `voice_session` history table for usage stats (not v1).

### 3.12 Recording (module `recording`)
**recording** : id, channel_id, started_by, started_at, ended_at?, storage_key?, status ('recording'|'processing'|'ready'|'failed'), size?.

### 3.13 E2EE (module `voice-e2ee`)
E2EE keys are **never stored in the DB**. Per 10 §4: room keys are derived with HKDF from the instance secret (config), a per-room-session random salt and an epoch counter; the salt and epoch live only in the pubsub `kv` with a TTL while the room is active. Nothing for this module is persisted in the database.

## 4. Pagination and ordering

- Messages: `GET …/messages?before=<id>&limit=50` or `after=<id>` or `around=<id>`; ordered by `id`. Because ULIDs are time-ordered, no secondary sort is needed. Within the same millisecond, ULID monotonic generation preserves order inside a process; for multi-node, order is by ULID text which is stable and total.
- Never OFFSET.

## 5. Indexes (initial set)

| Table | Index | Purpose |
|---|---|---|
| message | (channel_id, id) | history paging |
| message | (author_id, id) | moderation lookups |
| message_mention | (target_type, target_id, message_id) | mention inbox |
| session | token_hash unique; (user_id) | auth, session list |
| member_role | (user_id, space_id) | permission calc |
| invite | code unique | redemption |
| attachment | (message_id); (storage_key); (uploader_id, deleted_at) | GC, serving, per-user quota sum |
| read_state | PK | |
| audit_log | (space_id, id) | admin viewer |

## 6. Data lifecycle

| Data | Retention | Notes |
|---|---|---|
| Messages | Forever by default; optional `retentionDays` per channel | Hard-delete job removes content + attachments |
| Deleted messages | Soft-deleted content retained 30 days for moderation, then purged | configurable |
| Sessions | Until expiry/revocation | purge job |
| Audit log | 1 year default | configurable |
| Voice presence | Ephemeral | |
| Attachments | Tied to messages; GC of orphans after 24 h | |
| Recordings | Until manually deleted | |

## 7. Backup and restore

- SQLite: online backup using the SQLite backup API (`VACUUM INTO` or `.backup`) producing a consistent snapshot while running; scheduled by the `backup.hook` job.
- Postgres: standard `pg_dump` / PITR; documented, not reinvented.
- Storage: directory copy (local) or bucket versioning (S3).
- Config file + LiveKit config included in backup docs.
- Restore procedure documented and **tested in CI** (restore from snapshot → boot → smoke test) (16).

## 8. Migrations policy

- Forward-only, versioned per module, idempotent when re-run.
- Destructive migrations (drop column/table) require two releases: stop using → remove.
- Boot refuses if the DB schema is *newer* than the server understands (downgrade protection).
- Backup recommended automatically before applying pending migrations (SQLite: copy file; configurable).

## 9. Sizing estimates (sanity check)

100 users, 200 messages/user/day, ~300 bytes average: ~6 MB/day of message data, ~2 GB/year. SQLite handles this comfortably. FTS roughly doubles message storage. Attachments dominate; plan storage by upload limits.

## Open items
- Bitset width: permissions may exceed 53 bits? Use BigInt strings (11).
- Custom emoji, stickers: deferred.
- DMs/group DMs: not modelled. If wanted, they become a `channel` type `dm` with a `channel_participant` table; would affect 11 and 07 (flag in 18).
- ~~E2EE key epoch persistence~~ Resolved: not persisted (10 §4).
- Whether threads are wanted (would add `thread` rows or `parent_message_id`); deferred.
