# Tin Can admin guide (draft, M5)

For the person who runs the server. Design background is in docs 11 (permissions), 14 (deployment) and 15 (security); this page is the how-to. `tincan` below means `docker compose exec tincan node dist/cli.js` from your deploy directory, or `pnpm tincan --config <dir>/config.yaml` from a checkout.

## 1. What you are responsible for

You are the data controller of your members' messages, files and call metadata. Text and files are readable by you. Voice and video are encrypted so that **the media server cannot read them**, but the keys come from your server, so **you can**. Say so to your members; the lock in the call says it too.

## 2. Moderation

Roles decide who may do what (Settings › Roles). The default **Moderator** role can kick, time out, server-mute and move; **Admin** adds bans and role management; you, the owner, can do everything and cannot be acted on.

| Action | Where | Effect | Permission |
|---|---|---|---|
| Time out (1 minute to 28 days) | click a member › Time out | They can read but not write, react, speak, share or use the camera; ends by itself, or press End timeout | `TIMEOUT_MEMBERS` |
| Server mute / deafen | member card (when they are in voice) | Takes the microphone (or everything they hear) away until you lift it, **also if they leave and rejoin** | `MUTE_MEMBERS` |
| Move / disconnect | member card (in voice) | Sends them to another voice channel (they join it automatically) or out of the call | `MOVE_MEMBERS` |
| Kick | member card | Signs them out everywhere and out of voice. They can sign in again. | `KICK_MEMBERS` |
| Ban | member card | As kick, and every later login is refused with your reason, until you lift it. Optionally deletes their messages of the last 1 or 7 days. | `BAN_MEMBERS` |
| Lift a ban | Settings › Moderation › Banned people | | `BAN_MEMBERS` |

Rules the server enforces on every call: you cannot act on yourself, on the owner, or on someone whose top role is **equal to or above yours**. A refused action shows the reason ("that member ranks at or above you").

**Audit log:** Settings › Moderation shows who did what, newest first, with filters; it needs `VIEW_AUDIT_LOG`. It records kicks, bans, timeouts, mutes, moves, role changes and password-reset codes. It never records message text.

Bans are by account. A banned person can register a new account if signup is open; keep signup `invite-only`.

## 3. Voice encryption

New installs encrypt voice by default. Settings › Server › **Encrypt voice calls by default** is the server default; each voice channel can **Follow the server default**, **Always encrypt** or **Never encrypt** (channel menu › Edit). Changing it while people are in the call restarts that call (they rejoin by themselves).

- An encrypted call cannot be joined by a browser without the needed support (current Chrome and Edge; Firefox is expected to work, Safari is not tested). They are told why.
- Keys are replaced when someone is kicked, banned, loses access or is moved out, every 6 hours, and after a quiet leave. Nothing to do.
- If you think call keys leaked: `tincan e2ee rotate-secret` (a running server rekeys every call within 30 seconds). If the **instance secret** in `.env` leaked, replace it there and restart.
- What stays visible to the media server and to you: who is in which call, when, who is speaking, bitrates and addresses.

## 4. Backups and restore

### Take a backup

```bash
tincan backup --out /srv/backups --keep 14
```

This writes `tincan-backup-<time>.tar.gz` (a plain archive: `tar -tzf` lists it) with a consistent copy of the database (taken while the server keeps running), the uploaded files, and `config.yaml`, `docker-compose.yml` and the `Caddyfile`. **Secrets are left out** (`config.yaml` has them blanked, `.env` and `livekit.yaml` are not included). Add `--include-secrets` to include them; then the archive is as sensitive as the server itself. Without `.env` a restored instance cannot keep sessions' IP hashes or voice keys consistent, so keep `.env` in your password manager or in an encrypted copy.

### Encrypt it

Give the backup a passphrase and the archive is encrypted (AES-256-GCM, a key derived from the passphrase with scrypt, a new random salt each time; a changed, cut-off or reordered byte is detected):

```bash
printf '%s' 'a long passphrase of your own, at least 12 characters' > ~/.tincan-backup-key && chmod 600 ~/.tincan-backup-key
tincan backup --passphrase-file ~/.tincan-backup-key --keep 14
```

The file is then called `tincan-backup-<time>.tar.gz.enc`. The passphrase can also come from `TINCAN_BACKUP_PASSPHRASE_FILE` or `TINCAN_BACKUP_PASSPHRASE` (put it in `.env` for the `backup` service below); `--encrypt` makes a missing passphrase an error instead of a silent plain archive. **Losing the passphrase loses the backup**: there is no recovery. Keep it in a password manager or on paper, *not* only on the server it protects. With a passphrase you can add `--include-secrets` (the `.env` and `livekit.yaml` go in, so a restore needs nothing else); without one Tin Can warns, because that archive is only as private as the server.

### Schedule it

Easiest: the `backup` profile of the compose file runs `tincan backup` once a day at 03:30 (the container's clock, UTC unless you set `TZ`) and keeps the newest 14:

```bash
docker compose --profile backup up -d
```

Archives land in `data/backups/` (beside the pre-upgrade snapshots). To encrypt them add `TINCAN_BACKUP_PASSPHRASE=…` to `.env` and run the command again; to include secrets also remove the two `#` before the `.env` and `livekit.yaml` lines of the `backup` service and add `--include-secrets` to its command. Without a compose profile, use a systemd user timer or cron: `deploy/backup/tincan-backup.timer`, `.service` and `.cron` are ready to copy (14 §6).

`tincan doctor` shows when the last backup was made and warns after 48 hours, a failed night, or when there never was one. The metrics endpoint exposes `tincan_last_backup_timestamp_seconds` and `tincan_last_backup_failed`, and the dashboards profile has the alerts `BackupStale` and `BackupFailed`.

### Keep a copy somewhere else

A backup on the same disk does not survive the disk, the provider account or the intruder. Pull the archives to another machine you control, from *that* machine, so the server holds no key to the copies:

```bash
sh deploy/backup/pull-backups.sh mkarl.io:tincan/data/backups ~/tincan-backups
```

(rsync when it exists, otherwise ssh and scp; it never deletes anything on your side.) Run it from cron or a scheduled task there, once a day after the backup. If you prefer pushing to a bucket or another host with `rclone`, `restic` or `rsync`, that works as well: the archives are ordinary files.

**Retention guidance (3-2-1):** three copies, on two kinds of storage, one off the machine. Keep 14 dailies on the host; keep a weekly and a monthly off-host copy for as long as you are comfortable holding members' data; delete older ones, since a backup holds everything you would otherwise have deleted. A database snapshot is also taken automatically before every upgrade that changes the schema (`data/backups/pre-migrate-*.db`, the newest five are kept).

### Restore

Into a **new, empty directory** (never over a live one):

```bash
tincan restore tincan-backup-2026-10-30T03-15-00Z.tar.gz --into /srv/tincan-restored
# it checks every file against its checksum and runs SQLite's integrity check before it moves anything into place
# an encrypted archive (.tar.gz.enc) also needs:  --passphrase-file ~/.tincan-backup-key
# it also compares the number of users, channels, messages and uploads with what the backup recorded
cp /safe/place/.env /srv/tincan-restored/.env     # secrets are not in the archive unless you asked
cd /srv/tincan-restored && docker compose up -d
```

The directory has the layout `tincan init` makes (`data/app.db`, `data/files/…`, `config.yaml`, `Caddyfile` …). **Test a restore before you need one.** `deploy/backup/restore-drill.sh` does it for you, on the server, without touching the live instance: it restores the newest backup into a scratch directory, starts a throw-away server on it (plain HTTP on `127.0.0.1:3999`, no voice, its own random secret), checks that it answers and knows the owner, and removes everything again. `PASSPHRASE_FILE=~/.tincan-backup-key sh restore-drill.sh` for an encrypted one. Once a month is a good habit; the drill is also what tells you the passphrase you wrote down is the right one.

## 5. Upgrade and rollback

Rehearsed with the real previous release (`node tools/upgrade-rehearsal/run.mjs --old <checkout>`: 12 checks, all passing at the end of M5).

1. `tincan backup --out … --include-secrets` and copy it off the machine.
2. Read the release notes. Bump the image tags in `docker-compose.yml`. `docker compose pull && docker compose up -d`.
3. On start the server applies migrations after taking `data/backups/pre-migrate-<time>.db`. Check `docker compose logs tincan` and `tincan doctor`.

**Rollback.** An older release **refuses to start** on a database a newer one has changed ("Refusing to start so nothing is damaged"): that is on purpose. To go back: stop, `tincan restore` the pre-upgrade backup into a new directory (or, if you only have the automatic snapshot, copy `pre-migrate-….db` over `data/app.db` with the server stopped), set the previous image tags, `docker compose up -d`. Anything written after the backup is lost; members' messages from that period are gone, so roll back early or not at all.

LiveKit restarts drop calls; the app restarting does not (people stay in the call and rejoin the gateway).

## 6. Metrics and dashboards

`GET /api/v1/metrics` (Prometheus text) answers three callers only: the scraper token, your owner session, and a request that reaches the app directly on `127.0.0.1`. Caddy answers 404 for it.

**New installs** (`tincan init`) get the token in `.env` (`TINCAN_MODULES__METRICS__TOKEN`), and the `dashboards` profile:

```bash
docker compose --profile dashboards up -d
ssh -L 3001:127.0.0.1:3001 you@your-server        # then open http://localhost:3001 (user admin, password GRAFANA_PASSWORD from .env)
```

Prometheus (`127.0.0.1:9090`) and Grafana (`127.0.0.1:3001`) are never published to the internet. The dashboard "Tin Can" shows requests and latency, gateway sessions, people in voice, the reconciler, memory and event-loop delay, uploads, moderation actions and key rotations.

**Existing installs** (made before M5) add, by hand: `TINCAN_MODULES__METRICS__TOKEN=<48 random hex characters>` to `.env`; `/api/v1/metrics` to the `@internal path` line of the Caddyfile and `Cross-Origin-Opener-Policy same-origin` to its `header` block; and, to use dashboards, the `monitoring/` directory and the two services from a freshly generated install (run `tincan init --dir /tmp/new …` and copy them), plus `GRAFANA_PASSWORD` in `.env`.

**Alerts worth having** (rules ship in `monitoring/alerts.yml`): app down 2 minutes, **voice reconciler repairs that go on for 30 minutes** (a primary path such as the LiveKit webhook is broken: check `webhook.urls` in `livekit.yaml`), LiveKit unreachable, 5xx above 5 %, event-loop delay above 250 ms, outbox backlog, upload memory above 1 GiB, memory above 1.5 GB. Also watch disk above 80 % and certificate expiry (`tincan doctor`).

**Logs** are JSON on stdout (Docker keeps them, rotate with the `json-file` limits in the compose file). Every API answer carries `X-Request-Id`; an error shown to a member includes it, and `docker compose logs tincan | grep <id>` finds the lines. Log lines never contain passwords, tokens, cookies, invite or reset codes, or message text.

## 7. Limits and capacity (what was measured)

On a desktop machine with the server and the test client in one process (pessimistic): 500 connected sockets cost about 190 KiB each; a message in a channel with 500 listeners is delivered to all of them in about 0.5 s, and one core saturates at roughly 20 000 deliveries a second; 200 simultaneous voice joins take under 2 s of server time. **Uploads stream to disk**: the server's memory grows by roughly 70 MiB however large the files are (measured up to 512 MiB, two at once; the ceiling you can set is 4 GiB). Only images up to 48 MiB are read back to make a thumbnail, within `modules.uploads.memoryBudgetBytes` (384 MiB default); beyond it an upload is told to try again. Disk space and the per-person quota are what limit uploads now. Voice capacity is LiveKit's and the provider's bandwidth (08 §5.5), not measured here.

Repeat on your own hardware (never against a live server): `pnpm load`, and `sh tools/load/soak.sh` for a memory-limited soak in Docker (`SOAK_MINUTES=30 SOAK_MEM=512m`).

## 8. Host hardening checklist

- Only these ports open: 80, 443, 7881/tcp, 7882/udp (and 5349/tcp, 3478/udp for TURN). Not 3000, 7880, 9090, 3001, or LiveKit's metrics port.
- SSH keys only, no root login, unattended security updates; Docker updated.
- Keep `signup: invite-only`. Review who holds Moderator and Admin.
- `.env` is mode 0600 and in your backups (encrypted). Rotate the LiveKit key and the metrics token when someone with access leaves.
- Run `tincan doctor --url https://<host>` after every change; read `docs/security/m5-review.md` §3 for what is still your risk.
- Test a restore once a quarter.

## 9. Troubleshooting

| Symptom | Likely cause | Look at |
|---|---|---|
| "This call is end-to-end encrypted and this browser cannot join it" | Browser without the needed APIs | Use Chrome/Edge, or set the channel to Never encrypt |
| Call restarts when you change a setting | By design (encryption mode) | |
| `429` on an image upload with "busy" | Image-decoding memory budget in use | Retry; see §7 |
| Prometheus shows the app "down" | Token mismatch | `monitoring/metrics-token` equals `TINCAN_MODULES__METRICS__TOKEN` |
| Rising `tincan_reconcile_repairs_total` | Webhooks not arriving | `livekit.yaml` webhook URL, `tincan doctor` |
| Restore says "not empty" | It refuses non-empty targets | Use a new directory |
| Old release will not start after an upgrade | Schema newer than it knows | Restore the pre-upgrade backup (§5) |
