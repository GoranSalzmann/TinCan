# Changelog

All notable changes to Tin Can are written here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). A change that needs manual steps is called out under "Before you upgrade" in the entry. `apiVersion` (the number in `/api/v1/capabilities`) is separate from the product version.

The release workflow copies the section for the tagged version into the GitHub Release, so write entries for the person who runs a server first, and for members second.

## [Unreleased]

### Fixed

- **The "new version" banner now shows up more reliably in a window that stays open:** a check that hung on a dead connection could swallow the check made when the connection returned, a check made while the server was still starting was never repeated, and a window that stays in the foreground (an installed app) never looked again. Checks now time out after 10 seconds, are retried a few times, are also made when the window is focused, when the network returns and once a minute while the tab is shown (one small request, paused while the tab is hidden, and stopped once the banner is showing).

## [1.0.3] - 2026-11-02

Nothing to do when upgrading. Build and pipeline updates only; a tab that is open during the update shows the new-version banner.

### Changed

- The build and release pipeline uses newer versions of GitHub Actions (checkout, Node and pnpm setup, Docker build, CodeQL). The images themselves are built from the same code as 1.0.2.

## [1.0.2] - 2026-11-02

Nothing to do when upgrading. Members with a tab open during the update see a banner with a Reload button.

### Added

- **Open tabs recover from a server update:** a tab that stayed open across a release now shows a "new version" banner with a Reload button (checked when the connection returns and when the tab is shown again), and a page that cannot load a file of its old build reloads itself once instead of failing, except during a call, where only the banner appears. Unsent messages are kept. See [docs/guides/deploy.md](docs/guides/deploy.md).

## [1.0.1] - 2026-11-02

Nothing to do when upgrading. This is the first release that was rolled out by the automatic deployment.

### Added

- **Automatic deployment (optional):** a Deploy workflow that, after each release, connects to your server with a restricted ssh key and runs `deploy/deploy.sh`: verified backup first, images pulled by version, only the image lines of `docker-compose.yml` changed, health, reported version and `tincan doctor` checked, and a rollback (including restoring the pre-migration snapshot, with the lost data window stated) when the new version does not come up. Set-up, exit codes and security notes in [docs/guides/deploy.md](docs/guides/deploy.md). Nothing changes for installations that do not set it up.

### Changed

- Dependency updates (development tools and minor/patch versions of the libraries).
- CI: nightly media and clean-install tests run on Ubuntu 24.04; CodeQL is skipped on Dependabot pull requests (it cannot upload results there); the deploy test for the lock no longer depends on the environment.

## [1.0.0] - 2026-10-30

First release (1.0.0). There was no public beta. Everything below was built before the first release and ran on one server (the author's) with a small group of friends; read the list of what is not proven in [docs/17](docs/17-roadmap-and-milestones.md#v10).

### Added

- **TURN relay checks (M3 follow-up):** `tincan doctor` sends a TURN request over 5349/tls and 3478/udp instead of only checking the certificate; `tincan voice turn-snippets` prints the lines that switch TURN on for an existing installation; `tincan voice test-token` and `pnpm turn-test` prove relay-only media from a browser. Relay over UDP 3478 and TLS 5349 verified on a real host. **Known limit:** LiveKit tells clients to use the TLS relay on port 443, not 5349, so people who can reach only 443 do not benefit yet ([TURN guide §6](docs/guides/turn.md)).
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

[Unreleased]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/GoranSalzmann/TinCan/releases/tag/v1.0.0
