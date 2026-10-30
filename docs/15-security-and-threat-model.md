# 15. Security & Threat Model

Consolidates the security posture. Component-specific controls are in 05, 07,
10, 11, 13, 14; this doc adds the system-level threat model, the control
catalogue, and the security process.

## 1. Assets

| Asset | Why it matters |
|---|---|
| Account credentials & session tokens | Impersonation, admin takeover |
| Message content & attachments | Privacy (friends' conversations) |
| Voice/video media | Privacy, especially screenshares (may show passwords, private data) |
| Instance secrets (LiveKit key/secret, instance secret, signing keys) | Forge tokens, derive E2EE keys, read data |
| Host server integrity | Everything else |
| User devices (desktop app) | Native bridge could be abused (RCE) |
| Availability | Voice/chat working |
| Reputation/legal exposure of Host | Abuse content, spam |

## 2. Actors

| Actor | Capability / intent |
|---|---|
| Anonymous internet attacker | Scan, brute-force, exploit pre-auth bugs, abuse signup |
| Malicious invited member | Authenticated, tries privilege escalation, XSS via messages, resource abuse, harassment |
| Compromised member account | As above, with a trusted identity |
| Malicious/compromised Host | Controls server; can read text; can obtain E2EE keys (10 §2) |
| Network attacker (MITM) | Observe or alter traffic if TLS misconfigured; downgrade attacks |
| Compromised media server component | Reads unencrypted media (mitigated by E2EE) |
| Supply-chain attacker | Poisoned dependency, update channel, or Docker image |
| Local attacker on a user device | Reads local files, tokens, logs |
| Curious sharer/viewer | Records streams (cannot be prevented; out of scope) |

## 3. Trust boundaries

```
 [User device]──TLS──[Caddy]──[App server]──[DB/Files]
      │                          │
      └──TLS/DTLS-SRTP──[LiveKit]┘ (internal API + webhook, shared secret)
 Boundaries: device ⇄ internet · internet ⇄ edge · edge ⇄ app · app ⇄ LiveKit ·
             app ⇄ storage/db · desktop renderer ⇄ main process · desktop app ⇄ update server
```

## 4. Threat analysis by component (STRIDE-oriented)

### 4.1 Authentication & sessions
| Threat | Control |
|---|---|
| Credential stuffing / brute force | Rate limits per IP+username, delay, uniform responses, argon2id (11 §1.3) |
| Session theft | High-entropy tokens, hashed at rest, HttpOnly/SameSite cookies on web, OS keychain on desktop, revocation UI |
| Fixation / CSRF | Token rotation on login; CSRF header in cookie mode; Origin checks |
| Account takeover via reset | No email reset; admin-issued one-time codes; revoke sessions on use |
| Unclaimed fresh instance | One-time setup token (11 §1.4) |
| Invite abuse / enumeration | ≥60-bit codes, rate limit, expiry, max uses, audit |

### 4.2 API & gateway
| Threat | Control |
|---|---|
| Broken access control (IDOR, missing checks) | Single `can()` function, use-case-level checks, per-route tests; visibility filter on queries and event delivery (11 §2.5) |
| Injection (SQL) | Typed query builder with parameters only; no string-concatenated SQL; lint rule |
| Mass assignment | Zod schemas with `.strict()`; explicit field mapping |
| DoS via large payloads/floods | Body/frame size limits, rate limits, per-socket queues, timeouts, connection caps per IP/user |
| WebSocket hijack (CSWSH) | Origin allow-list, token in `IDENTIFY` not in cookies for the gateway (cookie mode checks Origin) |
| Replay / duplicate | Nonces for message creation; idempotent webhook handlers |
| Information disclosure in errors | Stable error codes, no stack traces to clients, redacted logs |
| Enumeration of users | Member list gated by membership; uniform auth errors |

### 4.3 Content (XSS, uploads, previews)
| Threat | Control |
|---|---|
| Stored XSS via messages/usernames/channel names | Server stores raw text; client renders sanitised AST (no raw HTML); output-encode everywhere; strict CSP |
| Malicious files | Size limits; content-type sniffing; serve with `nosniff`; non-image types as attachments; user content from a separate origin or with `Content-Security-Policy: sandbox`; optional AV hook (ClamAV) later |
| SVG scripts | SVG treated as downloadable attachment or rasterised, never inline-rendered from untrusted source |
| Image parser exploits | Thumbnailing in a worker with `sharp`/libvips and pixel limits; keep dependencies patched |
| SSRF via link previews | Off by default; fetcher blocks private/loopback/link-local ranges and metadata IPs, DNS-rebinding safe (resolve once, connect to IP), redirect limits, size/time limits, no cookies |
| Phishing links | Link confirmation for lookalike/IDN domains; no auto-opening; show real host |
| Path traversal | Storage keys are generated IDs, not user filenames; filename sanitised for `Content-Disposition` only |

### 4.4 Voice/video
| Threat | Control |
|---|---|
| Joining without permission | Tokens only from the app after `CONNECT` check; short TTL; LiveKit API secret never leaves server |
| Token sharing | Identity bound; duplicate identity displaces the old connection; TTL short |
| Revoked user stays in a call | Revocation never relies on token expiry: `RoomService` removal on the event, plus a reconciler that re-checks every participant's permissions each pass and rotates the E2EE key when it removes someone (05 §6.3) |
| Unauthorised publishing | `canPublishSources` limited per permission; server-mute/revoke via `updateParticipant` |
| Eavesdropping at the SFU | DTLS-SRTP in transit; optional frame-level E2EE (10) |
| Webhook forgery | Signature verification; internal-only route; shared secret |
| Server resource exhaustion (huge bitrates, many tracks) | Per-channel caps, `maxParticipants`, token grants limit sources |
| Harassment via screenshare/camera | Viewer opt-in watching (08 §4.2), moderators can revoke publish rights, audit log |
| Privacy leaks via screenshare | Source picker excludes own window by default; notification pause while sharing; sharing indicator |
| IP exposure through WebRTC | Participants can learn each other's IPs only via the SFU path; since traffic flows peer↔server (not P2P), peers do not see each other's IPs. TURN/server sees client IPs (Host-visible, as with any server) |

### 4.5 E2EE
See 10 §2 for what it does and does not protect. Additional controls: keys in memory only on clients; secret redaction in logs; rotation on membership change; downgrade prevention by server-enforced mode.

### 4.6 Desktop app
| Threat | Control |
|---|---|
| Remote code execution through renderer XSS reaching Node | `nodeIntegration` off, `contextIsolation` and `sandbox` on, minimal preload, validated IPC (13 §3) |
| Hostile server serving malicious code | Renderer bundled & signed; server cannot inject code into the native context |
| Navigation to attacker pages | `will-navigate`/window-open deny + allow-list |
| Malicious deep links | Strict parsing/validation of `tincan://` arguments; never execute |
| Update channel compromise | HTTPS + code-signature verification; signed releases; protected CI secrets; channel pinning |
| Token theft from disk | `safeStorage` encryption (OS keychain bound); logs redact tokens |
| Token sent to other sites by header injection | The main process adds `Authorization` only for the configured instance origin(s) (13 §3) |
| Global keyboard capture abuse | No native input hook in v1; only Electron `globalShortcut` registrations for toggle-mute/deafen/leave (no raw key stream). If a hook is added in v1.1: opt-in, binding-only events, no logging, active only in call |

### 4.7 Infrastructure / deployment
| Threat | Control |
|---|---|
| Open ports/misconfigured services | Compose exposes only §14.3 ports; internal network for DB/Redis; doctor warns on exposed ports; LiveKit's port 7880 (signalling plus the RoomService admin API) stays off the public interface, and Caddy proxies only `/livekit/rtc*` (14 §2) |
| Leaked secrets in images/repos | Secrets via env/volumes; secret scanning in CI; `.env` gitignored; permission 0600 |
| Outdated components | Pinned versions plus Renovate/Dependabot, image scanning, release notes list advisories |
| Container escape/privilege | Non-root, read-only fs, dropped capabilities, no privileged mode (host networking only for LiveKit) |
| TLS misconfig | Caddy defaults (modern TLS), HSTS, automatic renewals, doctor checks expiry |
| Backups leaking secrets | Docs: encrypt backups; `tincan backup --encrypt` (age) option |

### 4.8 Supply chain
- Lockfiles committed; `pnpm install --frozen-lockfile` in CI; no postinstall scripts from untrusted packages (pnpm `onlyBuiltDependencies` allow-list).
- Dependency review: audit (`pnpm audit`), OSV scanner, licence scanner (AGPL compatibility, F2), minimal dependency count for security-critical paths.
- SBOM (CycloneDX/SPDX) generated at build and published with releases.
- Reproducible-ish builds from tagged commits; CI runners ephemeral; release signing keys in hardware-backed or CI-protected secrets; cosign for container images.
- Pin GitHub Actions by commit SHA; least-privilege CI tokens.
- Review process for dependency bumps in `apps/desktop` (native modules).
- 2FA on registries/GitHub for maintainers.

## 5. Security headers & browser policies

| Header | Value (sketch) |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://<host> https://<host>; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'` (tuned during build; Tailwind uses no inline styles at runtime; verify E2EE worker & audio worklet `blob:` needs) |
| `Strict-Transport-Security` | 1 year, includeSubDomains |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` (or `same-origin`) |
| `Permissions-Policy` | `camera=(self), microphone=(self), display-capture=(self), geolocation=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` (isolation not required; OK) |
| `X-Frame-Options` / `frame-ancestors` | deny |
| User content origin | Attachments served with `Content-Disposition` and sandbox CSP; ideally from a separate host (`files.example.com`) when the Host wants stronger isolation (optional) |

## 6. Privacy & data protection

- **No telemetry** by default, no third-party requests from clients (no CDNs, no fonts, no analytics, no emoji CDN).
- Data minimisation: coarse client info in sessions; IPs stored hashed with a rotating salt where retained; configurable retention.
- User rights (even self-hosted, good practice and GDPR-friendly): export own data (v1.x), delete account (11 §1.9), admin-visible data inventory in docs.
- Host responsibilities documented: they are the data controller; guidance on privacy notices, backup retention, lawful use.
- Logging: no message content, no tokens; request metadata only; retention 14 days default in Docker log rotation.
- E2EE limits explained honestly (10 §2).
- Screenshare transparency: sharers see who is watching and viewers are told they are visible (08 §5.6, client-reported, best-effort) · recording banner (08 §12).

## 7. Abuse & moderation controls

Invite-only default; rate limits; upload limits; slowmode; timeouts/kicks/bans;
audit log; message delete with purge window; optional word/link filters (future);
reporting flow (future). Public-facing instances (open signup) need extra:
CAPTCHA/PoW, email verification, stronger rate limits, content scanning; these
are documented as out-of-scope for v1 (Q9, K-13).

## 8. Security requirements summary (testable)

| ID | Requirement |
|---|---|
| S-01 | All HTTP is TLS (HSTS); WebSocket is WSS in production |
| S-02 | Passwords hashed with argon2id; no plaintext or reversible storage |
| S-03 | Session tokens stored hashed; revocable; expire |
| S-04 | Every state-changing endpoint checks permissions server-side |
| S-05 | No endpoint returns data from channels the caller cannot view |
| S-06 | Stored content cannot execute script in any client (web or desktop) |
| S-07 | Uploads cannot be rendered as active content in the app origin |
| S-08 | LiveKit credentials never reach clients; client tokens are short-lived and least-privilege |
| S-09 | Desktop renderer has no Node access; IPC validated; navigation locked. *Not applicable while there is no desktop app (17, M6 dropped).* |
| S-10 | Webhook endpoint rejects unsigned requests and is not publicly routable |
| S-11 | Rate limits present on auth, invite, upload, message routes |
| S-12 | Secrets absent from logs, images and repo |
| S-13 | Release artifacts signed; update integrity verified. *Applies to container images and checksums only (no desktop installers).* |
| S-14 | Dependencies scanned in CI; critical advisories block release |
| S-15 | E2EE-required channels cannot be joined unencrypted |
| S-16 | Losing CONNECT (ban, kick, role change) removes the user from voice within one reconciliation interval, even when the first removal attempt fails |

## 9. Security process

- **Vulnerability disclosure:** `SECURITY.md` with contact (private email / GitHub private advisories), response targets (acknowledge ≤ 3 days, fix critical ≤ 14 days where feasible), coordinated disclosure, credit.
- **Patch cadence:** Electron/Chromium and LiveKit security releases tracked; target to ship patched desktop builds within days; server image rebuilds weekly with base-image updates.
- **Security review gates:** threat-model delta required for new modules; checklist in PR template; at least one pass of an automated scanner (SAST: CodeQL/Semgrep) on each PR.
- **Testing:** unit tests for permission engine and hierarchy; authorisation matrix integration tests (every endpoint × role × channel); fuzzing of gateway frames and markdown renderer; ZAP baseline against staging; Electron navigation/IPC abuse tests (13 §10, 16); dependency/image scans; periodic manual review of auth, uploads and the desktop bridge. An external review is recommended before a public 1.0 if budget allows.
- **Incident response (Host guide):** rotate secrets (`tincan e2ee rotate-secret`, regenerate LiveKit keys, invalidate sessions via CLI), restore from backup, notify members.

## 10. Known gaps / accepted risks (v1)

| Gap | Rationale |
|---|---|
| Text not E2EE | Scope (ADR-011); Host trusted |
| Host can obtain voice E2EE keys | Needs MLS-class design; roadmap |
| No 2FA at launch | v1.1 module (T13) |
| No malware scanning of uploads | Optional ClamAV hook later |
| No reporting/auto-moderation | Small-community model |
| Viewers can record shared screens | Inherent; documented |
| IP addresses visible to the Host/TURN | Inherent to a server-mediated design |
| Password recovery depends on admin | No email in v1 |

## Open items
- Separate origin for user content as default vs optional.
- Whether to bundle ClamAV profile.
- PoW/anti-bruteforce challenge necessity.
- External security review budget/timing.
- CSP tuning details after implementation (workers, worklets, WASM).
