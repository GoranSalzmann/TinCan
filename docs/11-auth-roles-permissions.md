# 11. Authentication, Roles & Permissions

Covers identity, sessions, first-run setup, invites, OIDC, the permission model,
how permissions are computed and enforced, and how changes propagate to live
connections (gateway and LiveKit).

## 1. Authentication

### 1.1 Local accounts
- Username (2–32 chars, `[a-z0-9._-]`, stored lowercase, unique) and display name (any printable, 1–32).
- **Password hashing: argon2id.** Initial parameters: memory 64 MiB, iterations 3, parallelism 1, tuned so one hash takes ≈150–300 ms on the Host's hardware (a `tincan bench-auth` command suggests values). Parameters stored in the hash string so they can be raised later; rehash on login when parameters are outdated.
- Password policy: minimum 10 characters, maximum 256, no composition rules; reject the top-N breached/common passwords from a bundled offline list (no network call). Show a strength hint.
- No email requirement in v1 (self-hosted friends). Consequently **no email-based reset**; see §1.6.

### 1.2 Sessions
- On login the server creates a session with a random 256-bit token (base64url). Only `SHA-256(token)` is stored (06 §3.1). The token is shown once to the client.
- Sliding expiry: default 30 days idle, 90 days absolute; configurable. `last_used_at` updates are throttled (at most once per few minutes) to avoid write amplification.
- Revocation: per-session (user's session list), all other sessions (on password change), all sessions (admin action, ban, disable).
- Client storage:
  - **Desktop:** token encrypted with the OS keychain via Electron `safeStorage`, stored in the user-data directory; never in renderer-accessible storage (13).
  - **Web:** HttpOnly + Secure + SameSite=Strict cookie by default (CSRF header required for mutating calls) or bearer token in memory with refresh via cookie. Not `localStorage` for the long-lived secret.
- WebSocket uses the same token in `IDENTIFY` (07).
- **As built in M1.** Login sets the HttpOnly, SameSite=Strict cookie `tincan_session` (Secure when `publicUrl` is https) and also returns the token in the body for desktop and CLI clients. A request authenticated by cookie must carry the header `X-Tincan-CSRF` (any value) on every non-GET call, which a cross-site page cannot add. Scripts cannot read the cookie, so the web client calls `POST /auth/gateway-ticket` and sends the 30-second single-use `ticket` in `IDENTIFY`/`RESUME` instead of a token. Rate limits: 10 logins per 15 min per IP, 5 per username (reset on success).
- Session list shows client name, last-used time, coarse location (IP hashed; optional display of last IP octets off by default), "this device" marker, revoke buttons.

### 1.3 Login throttling & abuse
- Rate limits per IP and per username (07 §2.4). Failed attempts incur exponential delay; no account lockout that enables DoS against a victim (instead, slow-down plus CAPTCHA-free proof: consider a small proof-of-work challenge after repeated failures; optional later).
- Uniform error message and timing for "unknown user" vs "wrong password" (always perform a dummy hash).
- Audit-log entries for admin-relevant events (owner login from new IP optional).

### 1.4 First-run setup
Problem: a freshly deployed instance exposed to the internet must not let a random
visitor claim ownership.
- On first boot with an empty user table the server generates a one-time **setup token**, prints it to the log and writes it to `/data/setup-token` (readable only by the Host).
- `POST /auth/setup` requires that token; creates the owner user (`is_instance_owner`), the default space, `@everyone`, Moderator and Admin roles, and a first text channel (`general`) and voice channel (`Lounge`); deletes the token.
- Until setup completes, all other endpoints return `SETUP_REQUIRED` (clients show the setup screen).
- Alternatively `tincan setup --username … ` via CLI.
- **As built in M1.** The token is `XXXX-XXXX-XXXX-XXXX` (16 characters from an alphabet without 0/O/1/I/L/U, about 78 bits), compared case-, space- and dash-insensitively in constant time. `tincan init` writes it to `data/setup-token` (mode 0600) and prints it, so the Host has it before the first boot; the server creates one only if the file is missing. `POST /auth/setup/verify` checks a token without creating anything (the wizard's first step), and both calls share a limit of 10 tries per 15 minutes per IP. Setup creates the owner, the one space and the owner's membership in one `BEGIN IMMEDIATE` transaction (a partial unique index allows only one `is_instance_owner`, so two racing setups cannot both win); `@everyone`, Moderator and Admin, `#general` and `Lounge` arrive with `roles` and `channels` in M2.

### 1.5 Registration and invites
- Default signup policy: `invite-only`. Config values: `invite-only | open | closed` (closed = admin creates accounts).
- Invite: random 10–12 character URL-safe code (≥ 60 bits entropy), optional `expiresAt`, `maxUses`, `defaultRoleId`, creator recorded. `GET /invites/:code` shows instance name/icon and member count without auth.
- Redeem: `POST /auth/register {inviteCode, username, password, displayName}`, atomic increment of `uses` under a transaction (prevents exceeding `maxUses` under races).
- Banned users cannot redeem (matched by identity/user ID; fresh accounts from a banned person are a moderation matter, optional IP-based soft block off by default).
- Invite deep link format: `tincan://invite/<host>/<code>` for desktop plus `https://host/invite/<code>` which offers "Open in app / Continue in browser" (13).

### 1.6 Password recovery (no email)
- Admin generates a **one-time reset link/code** for a user (`POST /admin/users/:id/reset-token`, expires 1 h); the Host sends it out-of-band. Also via CLI `tincan user reset-password`.
- The user redeems the code on the login screen ("Use a reset code") via `POST /auth/reset` (07 §3.2); codes are stored hashed in `password_reset` (06 §3.1), single use, expire after 1 hour; redeeming revokes all the user's sessions.
- If the owner loses access: CLI on the server host (`tincan user reset-password --owner`) — physical/SSH access is the trust anchor.
- Optional later: SMTP adapter enabling self-service email reset.

### 1.7 OIDC (module/adapter `oidc`)
- Authorization Code flow with PKCE via a standard library; discovery from the issuer URL; scopes `openid profile email`.
- Mapping: `(issuer, subject)` → `identity` row → user. First login with unknown identity: allowed only if signup policy permits (invite code carried through the flow via `state`) or `autoProvision` is set.
- Local passwords can be disabled when OIDC is the only method (`auth.kinds: [oidc]`); the owner retains a break-glass CLI recovery.
- Redirect URIs: web uses the instance URL; desktop uses a loopback redirect or custom protocol handler (13).
- Group/claim → role mapping is a possible later feature (config `roleMappings`), not v1.

### 1.8 Two-factor authentication
- Not in v1 core. Recommended as **v1.1** module `totp` (TOTP + recovery codes) since owners of public-facing instances want it. WebAuthn passkeys later. Flagged in 18.

### 1.9 Account lifecycle
- Change display name/avatar/status; change password (revokes other sessions).
- Disable (admin): blocks login, disconnects live sessions and voice.
- Delete account (self or admin): messages retained but author shown as "Deleted User" by default (option to purge messages); attachments follow. Required for privacy hygiene.
- Data export (user): JSON of their profile and messages (module, later); mention in 18.

## 2. Authorisation model

### 2.1 Concepts
- **Permission:** a named bit.
- **Role:** named set of permissions with a `position` (higher = more authority). Every member implicitly has `@everyone` (position 0).
- **Overwrite:** per-channel allow/deny bits for a role or a specific member.
- **Owner:** the instance owner implicitly has all permissions and cannot be restricted or removed (only transferred via CLI or an explicit owner action).
- **Administrator** permission: grants everything and bypasses channel overwrites (except owner-protection rules).

### 2.2 Permission catalogue
Bit positions are **globally allocated and stable** (defined in `packages/shared`,
never reassigned, never dependent on which modules are enabled). Disabled modules'
bits simply have no effect. Stored/transmitted as decimal strings of an unsigned
64-bit integer (use `BigInt` in JS; resolves T7). 64 bits leaves room for growth.

| Bit | Name | Scope | Meaning |
|---|---|---|---|
| 0 | `VIEW_CHANNEL` | channel | See the channel exists / read it |
| 1 | `SEND_MESSAGES` | text | Post messages |
| 2 | `READ_HISTORY` | text | See messages older than when they joined the view |
| 3 | `ATTACH_FILES` | text | Upload attachments |
| 4 | `EMBED_LINKS` | text | Link previews for their links |
| 5 | `ADD_REACTIONS` | text | Add reactions |
| 6 | `MENTION_EVERYONE` | text | Use @everyone/@here |
| 7 | `MANAGE_MESSAGES` | text | Delete others' messages, pin |
| 8 | `CONNECT` | voice | Join the voice channel |
| 9 | `SPEAK` | voice | Publish microphone |
| 10 | `VIDEO` | voice | Publish camera |
| 11 | `SCREEN_SHARE` | voice | Publish screen (and its audio) |
| 12 | `USE_VOICE_ACTIVITY` | voice | If denied, user must use push-to-talk |
| 13 | `MUTE_MEMBERS` | voice | Server-mute others |
| 14 | `MOVE_MEMBERS` | voice | Move/disconnect others |
| 15 | `MANAGE_CHANNELS` | instance | Create/edit/delete channels and categories |
| 16 | `MANAGE_ROLES` | instance | Create/edit roles below own highest; assign roles |
| 17 | `CREATE_INVITE` | instance | Create invites |
| 18 | `MANAGE_INVITES` | instance | Revoke others' invites |
| 19 | `KICK_MEMBERS` | instance | Kick |
| 20 | `BAN_MEMBERS` | instance | Ban/unban |
| 21 | `TIMEOUT_MEMBERS` | instance | Temporarily silence |
| 22 | `VIEW_AUDIT_LOG` | instance | Read audit log |
| 23 | `MANAGE_INSTANCE` | instance | Instance name/icon/settings |
| 24 | `CHANGE_NICKNAME` | instance | Change own nickname |
| 25 | `MANAGE_NICKNAMES` | instance | Change others' nicknames |
| 26 | `ADMINISTRATOR` | instance | Everything; ignores overwrites |
| 27–63 | reserved | | |

Default role bundles:
| Role | Permissions |
|---|---|
| `@everyone` | VIEW_CHANNEL, SEND_MESSAGES, READ_HISTORY, ATTACH_FILES, EMBED_LINKS, ADD_REACTIONS, CONNECT, SPEAK, VIDEO, SCREEN_SHARE, USE_VOICE_ACTIVITY, CREATE_INVITE, CHANGE_NICKNAME |
| Moderator | + MANAGE_MESSAGES, MUTE_MEMBERS, MOVE_MEMBERS, KICK_MEMBERS, TIMEOUT_MEMBERS, VIEW_AUDIT_LOG, MANAGE_NICKNAMES, MENTION_EVERYONE |
| Admin | + MANAGE_CHANNELS, MANAGE_ROLES, MANAGE_INVITES, BAN_MEMBERS, MANAGE_INSTANCE (everything except ADMINISTRATOR unless the Host grants it) |
Hosts can edit these. `CREATE_INVITE` default-on matches "friends invite friends"; a Host wanting control removes it.

### 2.3 Computation algorithm
Pure function in the domain layer (05 §2):

```
basePermissions(member):
    if member is owner: return ALL
    p = permissions(@everyone)
    for role in member.roles: p |= role.permissions
    if p has ADMINISTRATOR: return ALL
    return p

channelPermissions(member, channel):
    p = basePermissions(member)
    if p == ALL (admin/owner): return ALL
    # 1. @everyone overwrite
    ow = overwrite(channel, role=@everyone)
    p = (p & ~ow.deny) | ow.allow
    # 2. role overwrites (aggregate deny then allow across the member's roles)
    deny = OR of ow.deny for member's roles; allow = OR of ow.allow
    p = (p & ~deny) | allow
    # 3. member-specific overwrite
    ow = overwrite(channel, member=member)
    p = (p & ~ow.deny) | ow.allow
    # 4. implicit rules
    if not (p has VIEW_CHANNEL): strip all channel-scoped bits (no view → no access)
    if member is timed out: remove SEND_MESSAGES, ADD_REACTIONS, SPEAK, VIDEO, SCREEN_SHARE (keep VIEW/READ)
    return p
```
Properties: deterministic, order documented, table-driven unit tests with
exhaustive fixtures (16). Results are cached per (member, channel) and
invalidated by role/overwrite/membership events.

### 2.4 Hierarchy rules (who can act on whom)
- A member can only modify roles whose `position` is **below** their own highest role, and can only grant permissions they themselves hold (no privilege escalation).
- Kick/ban/timeout/server-mute/nickname changes require the actor's highest role to be above the target's highest role; nobody can act against the owner; the owner can act on anyone.
- Cannot delete/demote the last Administrator path to owner: owner is fixed.
- Self-modifications limited to own profile/nickname.
- These rules live in one `authorizeAction(actor, action, target)` function with tests.

### 2.5 Enforcement points (defence in depth)
1. **Use-case layer:** every command calls `can(actor, PERMISSION, resource)`. No permission checks in route handlers or UI-only.
2. **Gateway delivery filter:** events are delivered only if the recipient currently has `VIEW_CHANNEL` (05 §5).
3. **Queries:** history/search results filtered by current visibility (06 §3.9).
4. **LiveKit tokens:** `canPublishSources` derived from SPEAK/VIDEO/SCREEN_SHARE, `roomJoin` from CONNECT (08 §8).
5. **Uploads/files:** file access checked against the channel the attachment belongs to.
6. **Client UI:** hides/disable per `/capabilities` and `PERMISSIONS_UPDATE`; cosmetic only.

### 2.6 Propagation of changes to live connections
Triggered by role/overwrite/membership events on the bus:
| Change | Effects |
|---|---|
| Role permissions edited / role assigned or removed | Recompute affected members; send `PERMISSIONS_UPDATE` and channel add/remove events; revise gateway subscriptions; for users in voice: `updateParticipant` with new publish permissions; disconnect if CONNECT lost |
| Channel overwrite edited | Same, scoped to the channel |
| Kick | Notify (`YOU_WERE_KICKED`), remove from LiveKit rooms, close gateway sessions optionally (or leave them connected but empty-state), rotate E2EE key (10) |
| Ban | Kick + record ban + revoke sessions optional + block register/login redemption |
| Timeout | Set `timeout_until`; schedule a job to emit `PERMISSIONS_UPDATE` at expiry; enforce on write |
| Account disabled/deleted | Revoke all sessions, close sockets, remove from voice |

SLO: ≤ 2 s from change to enforcement on live connections while the event path
works. If a LiveKit call fails or the app restarts mid-propagation, the voice
reconciler (05 §6.3) enforces the change within one pass (≤ 30 s by default; 18 T25).

## 3. Moderation features (module `moderation`) summary
- Kick, ban (with optional message purge window 0–7 days, reason), timeout (1 min – 28 days), server-mute/move/disconnect in voice, delete messages, slowmode per channel.
- Everything creates an audit-log entry (06 §3.10): actor, action, target, reason, timestamp.
- Reports from users and auto-moderation (spam, link filters) are not in v1.

## 4. Admin tooling
- Owner/Admin UI: members list with roles, invites management, role editor with permission toggles and a "preview as member" view, channel permission editor showing effective result.
- CLI (`tincan user|invite|module|e2ee|backup`): create user, reset password, create invite, ban, dump effective permissions for debugging (`tincan perms explain --user X --channel Y`, prints each step of §2.3).

## 5. Security considerations
- Constant-time comparison for tokens (hash compare) and reset codes.
- Tokens, reset codes and invite codes generated with the platform CSPRNG; invite codes are bearer secrets and treated as such in logs (redacted).
- CSRF protection for cookie mode; strict Origin checks on gateway and REST for browsers.
- Brute-force protections on invite codes (rate limit per IP; codes sufficiently long).
- Privilege escalation tests are part of CI (16): role hierarchy, overwrite combos, permission delegation.
- All privileged actions require re-checking permissions at execution time, not trusting cached client state.

## Open items
- 2FA (TOTP) as v1.1 module: confirm.
- Account deletion semantics (retain vs purge messages) default.
- Whether to ship the optional proof-of-work/anti-bruteforce challenge.
- User data export module timing.
- Whether `CREATE_INVITE` should default on for `@everyone` (assumed yes).
- Per-user "do not disturb" and notification settings are covered in the client docs (12), not here.
