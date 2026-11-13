# Changelog

All notable changes to Tin Can are written here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). A change that needs manual steps is called out under "Before you upgrade" in the entry. `apiVersion` (the number in `/api/v1/capabilities`) is separate from the product version.

The release workflow copies the section for the tagged version into the GitHub Release, so write entries for the person who runs a server first, and for members second.

## [Unreleased]

### Added

- **Nudges ("anstupsen"):** a member can nudge another member from their member card in the member list. The target hears a sound and gets a desktop notification, or a Web Push while their app is closed (push module). `POST /api/v1/members/:id/nudge` answers `429 RATE_LIMITED` on cooldown — one nudge per member pair per `modules.nudge.cooldownSecs` (60 s by default) plus a per-sender burst cap (`modules.nudge.burst`, 10 per minute) — and `404` when the module is off (`modules.nudge.enabled: false`).
- GIF picker: search Tenor/GIPHY in the composer, send GIFs that the server re-hosts so the CSP keeps working (#33).
### Before you upgrade

- To use Linux application audio, add `http://127.0.0.1:19477` to `connect-src` in your existing web CSP and reload your reverse proxy. Newly generated Caddy configurations already include it. The web image includes the helper downloads; source deployments must package them before building the PWA. See [Linux application audio](docs/audio-helper.md).

### Added

- **Linux application audio:** share selected games and other apps from the PWA using a small Rust/PipeWire helper. Includes per-user installation, local server pairing, searchable multi-selection, a live meter, actionable setup errors and automatic cleanup. Conversation playback is routed separately and excluded from capture. Requires Linux x86-64, PipeWire with its PulseAudio service and a Chromium browser with output selection.

### Fixed

- **Screen-share cancellation:** cancelling setup or changing calls also cleans up media operations that complete late. Helper audio failure stops sharing and restores the conversation output. Browser audio requests `restrictOwnAudio` where Chromium supports it, and shared audio is not also played locally.

## [1.2.2] - 2026-11-13

Nothing to do when upgrading.

### Added

- **Preferred video codec:** choose Auto, VP8, H.264, VP9 or AV1 independently for camera and screen sharing. The choice is saved in this browser and preselected next time, including after a reload. Unsupported choices use VP8 without losing the preference; AV1 needs a power-efficient encoder. A codec change for a running screen share takes effect when sharing is restarted.

### Fixed

- **Saved video settings:** preferences are now restored after a reload instead of being discarded during initialization.
- **Live screen-share settings:** quality changes keep the running codec and correctly limit lower layers when reducing the resolution.

## [1.2.1] - 2026-11-13

Nothing to do when upgrading. Fixes a 1.2.0 start-up failure: the 1.2.0 server did not start, so the deploy rolled back to 1.1.1 and no data was lost.

### Fixed

- **Server start-up:** the server starts again with the Web Push library. PR checks now start the built server, so this kind of failure is caught before a release.

## [1.2.0] - 2026-11-12

Nothing to do when upgrading. Browser notifications now ask for permission at a moment you choose, and they keep working when the Tin Can tab is closed, as long as the browser allows it.

### Added

- **Desktop notifications that reach you:** the permission prompt is asked again on your next click until you answer it, and the browser's permission is re-read when you come back to the tab. Notifications are shown through the service worker, so they appear even when no Tin Can tab is open.
- **Web Push:** a switch in notification settings subscribes this browser to push messages from the server. The server only sends to push services it recognises, and only while you are offline. The keys come from the instance secret, so there is nothing new to configure.
- **Interface sounds:** short synthesized cues for new messages and mentions, joining and leaving calls, mute and deafen, screen sharing, lost voice connections and error messages. Nothing is downloaded. A Sounds card in notification settings has a master switch, a volume control, a sample button and a switch for each kind of sound. The choices are kept in each browser.

### Fixed

- **Text channels open at the newest messages:** re-entering a channel no longer leaves you short of the bottom, and "jump to latest" always reaches the end.
- **Hovering a message timestamp** no longer shifts the message height.

## [1.1.1] - 2026-11-12

Nothing to do when upgrading.

### Fixed

- **Speaking ring in calls:** your own ring no longer flickers on and off, and a click or tap no longer lights it. It stays lit while you talk and turns off once you stop.
- **Screen sharing:** the Stop sharing button no longer overlaps the members button and the connection status in the top-right corner.

## [1.1.0] - 2026-11-02

Nothing to do when upgrading. Link previews are **off** until the owner turns them on in Settings › Server › Link previews, and then only for the sites on an allow list that is filled in with YouTube, Vimeo, SoundCloud, Spotify, Bluesky, X/Twitter and GitHub (change it, restore it, or choose "allow all sites" in the same place).

### Added

- **Animated images play in place:** GIFs, animated WebP and animated PNG move inside the message. Anything over 8 MB, and everything when your system asks for reduced motion, shows a still picture with a play button.
- **Video and audio players:** uploaded videos (mp4, webm, mov) and audio (mp3, ogg, wav, m4a, flac) can be played in the message. Nothing starts by itself, starting one pauses the other, and a video your browser cannot play shows a download link instead. Seeking works because the file endpoint now answers `Range` requests.
- **File type icons** for documents, spreadsheets, presentations, archives, code, text, 3D models and fonts, each with the type written next to the icon.
- **Text previews:** the first lines of text files (txt, md, csv, json, log, html, source code …) show in the message, as plain text only. HTML is shown as source, never run.
- **Link previews** (owner switch, off by default): a card with the title, description and picture of a link. The server fetches the page, never a member's browser, so sites do not see members' addresses. Private and internal addresses are refused, the owner decides which sites get previews (allow list with a default, deny list, and an explicit "allow all sites" switch with a warning), and the author or a moderator can remove a message's previews. Works for YouTube, Vimeo, SoundCloud, Spotify, Bluesky and most pages with Open Graph tags; X/Twitter posts show their text when X allows it without a key.

### Fixed

- Files whose type label says audio or video but whose content is something else are now stored as plain downloads.

## [1.0.5] - 2026-11-02

Nothing to do when upgrading. Layout fixes and resizable side panels; a window that was open during the update should show the new-version banner within about a minute.

### Added

- **The channel list and the member list can be resized:** drag the edge between a panel and the page, or focus the edge and use the arrow keys (Home and End for the smallest and largest, Enter or a double click for the default). The width is remembered in your browser. On a phone the channel list stays a drawer of fixed width.
- **The owner has a group of their own at the top of the member list.**

### Fixed

- **The voice status in the channel list is no longer cut off:** "Voice connected" and the channel name now wrap onto a second line, and the buttons move below them when the panel is narrow.
- **In a call, "End-to-end encrypted" and the connection indicator no longer overlap at the top right.** The connection indicator in the corner is a dot below 1280 px (its text is a tooltip and for screen readers; the word shows on wider windows), and the lock label becomes an icon on a phone.
- **The member list can always be closed:** below 1280 px the open list covered its own toggle. It now has a close button, closes with Escape, and puts the focus back on the toggle.
- **The channel menu (the three dots) stays next to the channel name** when people join or leave a voice channel instead of sliding down with the list of participants. A long voice channel name also no longer makes the channel list scroll sideways.

## [1.0.4] - 2026-11-02

Nothing to do when upgrading. Open windows (also the installed app) now notice an update reliably; windows that run 1.0.3 or older need one reload to get this.

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

[Unreleased]: https://github.com/GoranSalzmann/TinCan/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.5...v1.1.0
[1.0.5]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/GoranSalzmann/TinCan/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/GoranSalzmann/TinCan/releases/tag/v1.0.0
