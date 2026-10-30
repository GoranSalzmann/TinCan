# Backups: checklist and first run on the server

Built 2026-10-30 (18 §O, 14 §6). Everything marked **(local)** was run during the build: the whole path with the real server image in Docker (encrypted backup of a fresh instance, restore with the right, a wrong and no passphrase, a throw-away server on the restored data, clean-up) and the automated tests in `apps/server/src/cli/`. Rows marked **(VPS)** and **(you)** have **not** been run: nothing in this change was started on mkarl.io.

## A. Automated and local

- [ ] `pnpm check` is green (it includes the backup, encryption, schedule, doctor and template tests).
- [x] **(local)** `tincan backup` with a passphrase file writes `…tar.gz.enc` and `last-backup.json`; `doctor` shows "Last backup … 0 h ago, encrypted".
- [x] **(local)** `deploy/backup/restore-drill.sh` prints **PASS** for that archive; with a wrong passphrase or none it fails with a clear sentence and leaves no container or scratch directory behind.

## B. Decisions only you can make (before the first run)

| Decision | Suggestion |
|---|---|
| **Passphrase custody.** Losing it loses every encrypted backup | A long phrase of your own, kept in a password manager **and** on paper somewhere physical. Not only on the server |
| **Where the off-site copies live** | A machine you own at home or a second small server, pulling with `pull-backups.sh` over ssh. A bucket (`rclone`, `restic`) is fine too |
| **When and how many** | 03:30 daily, keep 14 on the server (the defaults); keep weeklies on your own copy for as long as you like |
| **Secrets in the archive?** | Yes, **only together with the passphrase**: then a restore needs nothing but the archive and the passphrase |

## C. First run on mkarl.io **(VPS)** (nothing here changes live data; steps 1 and 2 add files)

Update the deployment first: the `backup` service is new in the compose file. Take the new `docker-compose.yml` from `tincan init` in a scratch directory and keep your own `context:` lines, as for the dashboards.

1. [ ] Create the passphrase file on the server: `umask 077; printf '%s' 'YOUR PASSPHRASE' > ~/.tincan-backup-key`. Mount it into the `backup` service and set `TINCAN_BACKUP_PASSPHRASE_FILE` to it, **or** put `TINCAN_BACKUP_PASSPHRASE=…` in `.env`.
2. [ ] One backup by hand: `docker compose --profile backup run --rm --no-deps backup node dist/cli.js backup --keep 14`. It prints "encrypted" and a `…tar.gz.enc` appears in `~/tincan/data/backups/`.
3. [ ] `docker compose exec tincan node dist/cli.js doctor` says "Last backup … encrypted". After the dashboards' next scrape the metric `tincan_last_backup_timestamp_seconds` is non-zero and `BackupStale` clears.
4. [ ] **Restore drill:** `cd ~/tincan && PASSPHRASE_FILE=~/.tincan-backup-key sh ~/tincan-src/deploy/backup/restore-drill.sh` prints **PASS** (it needs `curl` and `docker`; it uses port 3999 on loopback). Run it again with a deliberately wrong passphrase file: it must **fail**.
5. [ ] Start the schedule: `docker compose --profile backup up -d`. Tomorrow morning a second archive exists and `doctor` says "… h ago".
6. [ ] **Off-site:** from your own machine, `sh pull-backups.sh mkarl.io:tincan/data/backups ~/tincan-backups`. The newest archive is there. Try the wrong passphrase on it (the drill's restore step does) and confirm it refuses.
7. [ ] **Real restore rehearsal** (once, before you ever need it): in a scratch directory, `tincan restore <archive> --into <empty dir> --passphrase-file <key>`, copy your real `.env` (or use an archive made with `--include-secrets`), `docker compose up -d`, log in with your own account and look at a channel you know.

## D. Failure behaviour

- [ ] **(VPS)** Point `--out` at a read-only directory once and run a backup: it exits non-zero, `last-backup-error.json` appears, `doctor` warns "the newest backup run failed", and the next good backup clears it.
- [ ] Stop the `backup` service for two days (or test on a copy with the clock set ahead): `doctor` warns after 48 h and `BackupStale` fires one hour later.
- [x] **(local)** A restore of an archive cut short, with a flipped byte, or with data appended refuses with "damaged" (automated).
