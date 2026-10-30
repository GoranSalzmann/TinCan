# Security review pass (M5)

Result of walking the checklist S-01 to S-16 (15 §8) and the process of 15 §9 against the code as it stands at the end of M5. Evidence is a test you can run (`pnpm vitest run <file>`), a file to read, or a measurement. **Status:** ✅ verified here · ⚠️ verified with a stated limit · ⛔ not verifiable yet (and why). Nothing was scanned against a real deployment; items that need one are marked **VPS**.

## 1. Checklist

| ID | Requirement | Status | Evidence and notes |
|---|---|---|---|
| S-01 | HTTP is TLS with HSTS, WebSocket is WSS | ⚠️ | The generated Caddyfile sends `Strict-Transport-Security` and terminates TLS (`templates.test.ts`); the app listens on `127.0.0.1:3000` only (compose). The plain-HTTP mode exists for `localhost` trials and says so. **VPS:** `tincan doctor` checks the live certificate and HSTS. |
| S-02 | Passwords hashed with argon2id | ✅ | `packages/auth/src/password.ts` (argon2id, parameters in the hash, rehash on login, `accounts.test.ts`). |
| S-03 | Session tokens hashed, revocable, expiring | ✅ | Only `SHA-256(token)` is stored (`security.test.ts` greps the table); idle and absolute expiry; revoked on logout, password change, reset, **kick and ban** (new), with sockets closed (`security.test.ts` "revocation", `moderation.test.ts`). |
| S-04 | Every state-changing endpoint checks permissions server-side | ✅ | `authz.matrix.test.ts`: every endpoint × six roles × three channel situations, now with 10 moderation rows (≈ 500 cells). **New:** `security.test.ts` lists all ~100 registered routes and fails if one neither runs `authenticate`/`requireOwner` nor is on the 12-entry public list, and fails if the list names a route that no longer exists. |
| S-05 | No endpoint returns data from channels the caller cannot view | ✅ | Matrix "no data leaks through other doors" (search, READY, files, error shapes). |
| S-06 | Stored content cannot execute script in any client | ✅ (web) | The renderer builds React elements from a parsed subset; there is no HTML path and no sanitiser to get wrong (`markdown.tsx`). Schemes limited to http, https, mailto; links open with `noopener,noreferrer`; lookalike hosts ask first. **New:** 17-payload XSS battery (`markdown.test.tsx`). Desktop: M6. |
| S-07 | Uploads cannot be rendered as active content in the app origin | ✅ | Non-image types are `attachment`, `application/octet-stream`; SVG is never inline; every file response carries `CSP: sandbox` and `nosniff` (`security.test.ts` serves an HTML and an SVG upload). Images are re-encoded for thumbnails and avatars. |
| S-08 | LiveKit credentials never reach clients; client tokens short-lived and least privilege | ✅ | Grant table in `voice.test.ts` (no admin, record, hidden, data flags; sources from permissions; 10-minute join token, LiveKit refreshes the live session, D1-1). **New:** no response carries the LiveKit or instance secret (`security.test.ts`). |
| S-09 | Desktop renderer has no Node access, IPC validated, navigation locked | ⛔ | No desktop app yet (M6). |
| S-10 | Webhook rejects unsigned requests and is not publicly routable | ✅ | `voice.test.ts` (bad signature → 401, counted); Caddy answers 404 for `/api/internal/*` and `/api/v1/internal/*`; `tincan doctor` checks both ends. **VPS:** doctor on the real host. |
| S-11 | Rate limits on auth, invite, upload, message routes | ✅ (improved) | Existing: login (10/15 min per address, 5 per name), register, setup, reset, invite preview, uploads, avatars, messages, edits, search, voice join and diagnostics. **New:** per member 600 reads and 120 writes a minute, per address 1200 a minute (webhook path exempt), 30 gateway sessions per member, 60 sockets per address, and streaming uploads with a shared memory budget for image decoding (`security.test.ts`). In memory, per node, reset by a restart: acceptable for a single node (T22). |
| S-12 | Secrets absent from logs, images and repo | ✅ (fixed) | **Fixed:** request lines showed invite codes in the URL. URLs are now logged as route shape; a test drives login, invite preview, reset and a cookie request and asserts that no password, token, cookie, invite or reset code, or instance secret appears (`security.test.ts`). `.env` is written `0600`; the secret scan runs in CI (`pnpm check:secrets`). Backups leave secrets out by default (`backup.test.ts`). |
| S-13 | Release artifacts signed, update integrity verified | ⛔ | No releases yet (v1.0); installers M6. |
| S-14 | Dependencies scanned in CI, critical advisories block release | ⚠️ | CodeQL on every change; **new:** `pnpm audit --audit-level high` in the PR workflow (clean today); licence scan. Image scanning, SBOM and cosign are release work (M7). LiveKit's image is pinned by tag, not digest. |
| S-15 | E2EE-required channels cannot be joined unencrypted | ⚠️ | The server refuses a client that does not report E2EE support (`moderation.test.ts` "refuses a client that cannot encrypt …"), for `required` and for `inherit` with the default on. **Limit:** the server cannot see inside frames, so a *modified* client that claims support and then publishes in the clear defeats it for its own stream; the other participants cannot decode a stream that is not encrypted with the room key, but the media server sees that person's plaintext. State this plainly to users (the lock tooltip does). |
| S-16 | Losing CONNECT removes the user from voice within one reconciliation interval, even when the first removal attempt fails | ✅ | `voice.test.ts` (fast path within 2 s; reconciler repairs after a failed first attempt, one counted repair) and the media test ("taking CONNECT away …", about 0.2 s). Kick, ban, timeout, server mute and move use the same paths (`moderation.test.ts`). |

## 2. The review pass of 15 §9 (what was read, what was found)

| Area | What I did | Finding |
|---|---|---|
| Authentication | Read login/register/reset/setup, cookie helper, CSRF gate. | Cookie is `HttpOnly; SameSite=Strict; Secure` over https; mutating calls with a cookie need `X-Tincan-CSRF`; bearer tokens need none (`security.test.ts`). Unknown user and wrong password are indistinguishable. No problem. |
| Authorisation | Hierarchy rules, `authorizeAction`, the new moderation paths. | Every moderation call checks permission **and** rank against live roles, refuses self and owner, and the same checks run after the voice layer is known to exist (a call by someone without the permission never learns whether voice is on). Tested for six roles. No problem. |
| Sessions and revocation | Followed every place a session ends. | Kick/ban revoke all sessions and close sockets; **there is no way to disable an account** (`ACCOUNT_DISABLED` is unreachable). Ban is the tool; noted. |
| Headers | Read the generated Caddyfile. | Present: CSP, HSTS, nosniff, referrer policy, permissions policy, frame-ancestors none. **Added:** `Cross-Origin-Opener-Policy: same-origin`, `geolocation=()`. `style-src-attr 'unsafe-inline'` stays for Radix popovers (documented in the file). The E2EE worker is a same-origin module worker, covered by `worker-src 'self' blob:`. |
| CSRF, CSWSH | Gateway origin handling. | Browsers' `Origin` must be the instance's; the web client authenticates the socket with a 30-second one-time ticket, so the cookie is never used on the socket (`security.test.ts`). Non-browser clients may omit `Origin`. |
| Uploads | Read the upload path, file serving, avatars, quotas. | Safe to serve (S-07). **Memory** was the weak spot (bodies were buffered); uploads now stream and the load run shows a flat +70 MiB (18 §M). |
| SSRF | Searched the server for outbound HTTP. | The server makes **no outbound requests on behalf of users** (no link previews exist; the only `fetch` calls are in the CLI doctor and in LiveKit's SDK client to the configured internal URL). Nothing to harden until a link-preview module is written; 15 §4.3 lists what it must do. |
| XSS in markdown and links | Read the parser and renderer; wrote the payload battery. | None found (S-06). Usernames, channel names and topics are text nodes. |
| Secrets handling | Config loading, logging, backup, CLI output, metrics. | Log URL leak fixed. `tincan config check` and `/admin/modules` print no secrets. The metrics endpoint exposes counts only (no user ids as label values; routes by pattern). `E2EE_KEY_UPDATE` frames and the join response carry keys by design and are never logged. |
| Voice | Token minting, webhook, reconciler, the new E2EE key service. | See S-08, S-10, S-15, S-16. Keys go only to people present in the room and with CONNECT; a removed person gets no further key (rotation on removal). |
| Abuse | Rate limits, caps, sizes. | Gaps closed (S-11). `bodyLimit` 256 KiB, WebSocket frame limits and slow-consumer disconnects were already there. |
| Dependencies | `pnpm audit`. | No known vulnerabilities at 2026-10-30. |

## 3. Residual risks (accepted or open)

| Risk | Severity | Why it stays / what would fix it |
|---|---|---|
| **The Host can read voice (E2EE keys derive from the Host's secret) and all text.** | By design | 10 §2, 15 §10. MLS-class design later. The UI says so. |
| Uploads stream to storage (memory about 70 MiB at any file size); only an image up to 48 MiB is decoded in memory, under a 384 MiB shared budget. Disk is the remaining resource: a member can fill their quota (2 GiB default) and the disk-full warning is a log line. | Low | Per-person quotas exist; watch the disk alert. |
| A modified client can publish unencrypted into an encrypted room (S-15), exceed the advisory bitrate caps (08 §5.2) or lie in the viewer list (08 §5.6). | Low–medium | Inherent to client-side media; server limits are advisory. |
| Rate limits are in memory per node and reset on restart. | Low | Single node in v1 (T22); the Redis adapter would carry them. |
| Rate limits key on the address from `X-Forwarded-For`; that is only trustworthy while the app port is not reachable except through Caddy. | Medium if misconfigured | Compose publishes `127.0.0.1:3000` only; `tincan doctor` should flag a public 3000 (not added here). |
| No 2FA, no upload malware scanning, no reports or auto-moderation, no CAPTCHA for open signup. | Accepted for v1 | 15 §10. Keep `invite-only`. |
| A banned person can register a new account (bans are by account). | Low | 11 §1.5 calls address blocking optional and off. |
| Session cookies live up to 30 days idle; no re-authentication for sensitive actions. | Low | Consider re-asking the password for ban/role changes in a later pass. |
| LiveKit's own metrics port, if the Host turns it on with host networking, listens on every interface. | Medium if enabled | Off by default; the generated file says to keep it closed in the host firewall. |
| Images are pinned by tag, not digest; no SBOM or signature yet. | Low until release | M7. |
| Electron surface (S-09, S-13). | Open | M6. |
| The `metrics` token sits in `.env` and `monitoring/metrics-token` (mode `0600`). | Low | Rotate by editing both and restarting. |

## 4. How to repeat this

```bash
pnpm vitest run apps/server/src/security.test.ts apps/server/src/authz.matrix.test.ts apps/server/src/moderation.test.ts
pnpm vitest run --project web markdown
pnpm audit --audit-level high
sh tools/media-test/docker.sh          # E2EE, rotation and the voice removal paths in a real browser
```

On the real server: `tincan doctor --url https://<host>`, and from outside the host check that `/api/v1/internal/livekit/webhook` and `/api/v1/metrics` answer 404 and that only 80, 443, 7881/tcp, 7882/udp (and 5349/tcp, 3478/udp with TURN) are open.
