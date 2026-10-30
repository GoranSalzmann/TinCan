# Changelog

All notable changes to Tin Can are written here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version (0.x) may change things that need manual steps; the entry says when. `apiVersion` (the number in `/api/v1/capabilities`) is separate from the product version.

The release workflow copies the section for the tagged version into the GitHub Release, so write entries for the person who runs a server first, and for members second.

## [Unreleased]

First public beta. Everything below was built before the first release and ran on one server (the author's) with a small group of friends.

### Added

- **Text chat (M2):** channels and categories, messages with formatting, mentions, replies, reactions, edits, pins, typing indicators, read state and unread markers, full-text search, file and image uploads with thumbnails, per-person upload quota, avatars.
- **Accounts and permissions (M1, M2):** owner setup with a one-time token (browser or `tincan setup`), invite links, password reset codes, roles and per-channel permission overwrites, sessions list with revoke. Passwords use argon2id.
- **Voice (M3):** voice channels on LiveKit with permission-derived grants, presence, an audio pipeline (browser echo cancellation, RNNoise noise suppression, presets, microphone test, push to talk while the window has focus, per-person volume up to 300 %), a connection test, and an optional TURN relay (5349/tcp, 3478/udp) with `tincan voice turn-reload`.
- **Camera and screen share (M4):** viewers opt in to watch, stream view, quality controls, the sharer sees who is watching, stream-audio volume, live revocation when permission is taken away. Owner-set server-wide caps (up to 60 Mbit/s camera and 25 Mbit/s screen share) and per-channel voice settings. A custom quality with independent resolution up to 4K and frame rate up to 60.
- **Moderation (M5):** timeout, server mute and deafen (kept when rejoining), move and disconnect, kick, ban with optional message purge, and an audit log.
- **End-to-end encrypted voice (M5):** on by default per server and per channel; keys rotate on removal, every 6 hours and with `tincan e2ee rotate-secret`. Browsers that cannot decrypt are refused with an explanation. The host can still derive the keys; text and files are not end-to-end encrypted.
- **Backups (M5 and after):** `tincan backup` and `tincan restore` with checksums, SQLite integrity check and row-count comparison; encrypted archives (AES-256-GCM, passphrase-derived key); a daily schedule in the `backup` compose profile; `deploy/backup/restore-drill.sh` and `pull-backups.sh`; `doctor` and metrics show the last backup. A schema snapshot is taken before every migration.
- **Operations (M1, M3, M5):** `tincan init` (config, secrets, Compose file, Caddyfile, LiveKit config, setup token), `tincan doctor` (DNS, HTTPS, WebSocket, voice, disk, memory, backup), Prometheus metrics and an optional Grafana `dashboards` profile, JSON logs with request ids, API rate limits and connection caps.
- **Installable web app (PWA):** manifest, icons, service worker, and cache rules in the generated Caddyfile.
- **Runtime upload limits:** the owner sets the largest file and the per-person quota under Settings › Server › Uploads, without a restart. Uploads stream to disk, so server memory stays flat whatever the file size, up to a 4 GiB ceiling.
- **Release and community files:** README, SECURITY, CONTRIBUTING, code of conduct, issue forms, Dependabot, a release workflow (multi-architecture images, SBOMs, checksums, provenance), `tincan init --image <name> --version <release>` to install from released images, a clean-install test, and a hosting guide.

### Changed

- `tincan init` now checks for Docker and Compose v2 and says what is missing, and tells you the next commands for the install mode you chose (built from a checkout or released images).
- GitHub Actions in the repository's workflows are pinned by commit SHA.

### Fixed

- A generated Caddyfile no longer breaks when no certificate email is given (found on the first real install).
- Voice: the right ear stayed silent with noise suppression on; the local speaking ring followed the wrong signal; the microphone is republished when speaking is allowed again.
- Timeouts were kept in memory only, lost on restart, and did not reach live voice sessions; they are stored and enforced now.
- Request logs showed invite codes in URLs; URLs are logged by route shape only.
- `TINCAN_BACKUP_PASSPHRASE` and `TINCAN_BACKUP_PASSPHRASE_FILE` were read as configuration settings and stopped the container from starting; restoring from an unreadable archive crashed instead of reporting an error.

### Security

- Security checklist S-01 to S-16 reviewed against the code ([docs/security/m5-review.md](docs/security/m5-review.md)); accepted and open risks are listed there. Dependencies are scanned with `pnpm audit` and CodeQL on every change.

### Known limits

- Not run yet: Safari, a phone, Firefox for video and encrypted calls, a real 4K screen. Encrypted calls with AV1 are untested.
- One server per community, SQLite only, no desktop or native mobile app, no two-factor login, no email.
- The host can read text, files and, through the key derivation, voice.

[Unreleased]: https://github.com/GoranSalzmann/TinCan/commits/main
