<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Tin Can

Tin Can is a chat server you run yourself, for a group of people who know each other: text channels, voice channels, camera and screen sharing, in the browser. You install it on a server you control with Docker, give your friends an invite link, and they use it in a normal browser tab or as an installed web app. The messages, files and call metadata stay on your server, and you decide who is in and who can do what. It is free software under the AGPL-3.0-or-later.

**Status: version 1.0, honestly labelled.** M0 to M5 and the TURN relay of the [roadmap](docs/17-roadmap-and-milestones.md) are built and run on one real server (the author's) with a handful of friends. There was no public beta: the author decided to release at 1.0 and to take feedback through GitHub Issues ([what that means and what is not proven](docs/17-roadmap-and-milestones.md#v10)). Expect rough edges on other people's servers, read the release notes before each upgrade, and keep backups. Not run yet: Safari, a phone, Firefox for video and encrypted calls, a restore on a second machine, and any installation other than the author's (see [what is tested](docs/qa/m5.md)). There is no support contract and no guarantee that a release will not need manual steps.

## Who it is for

A friends group, a club, a small team or a game community, roughly up to a few dozen people online at once, run by one person who is comfortable with a Linux server and a terminal. It is not meant to be a public service for strangers, and it does not try to replace Discord at Discord's size.

## What works today

- **Text:** channels, formatting, mentions, replies, reactions, edits, pins, file uploads (limits set by the owner, up to 4 GiB per file), search.
- **Voice:** voice channels over LiveKit, noise suppression, push to talk (while the window has focus), a connection test.
- **Camera and screen share:** viewers choose to watch, quality presets and a custom quality up to 4K and 60 fps, server-wide bitrate caps.
- **Roles and moderation:** roles and per-channel permissions, timeout, server mute, move, kick, ban, an audit log.
- **Encrypted voice (E2EE):** on by default. The media server cannot read calls; **you, the host, can**, because the keys derive from your server's secret. Text and files are not end-to-end encrypted. The details are in [docs/10](docs/10-end-to-end-encryption.md) and the [user guide](docs/guides/user-guide.md).
- **Backups:** `tincan backup` (optionally encrypted), a daily schedule, `tincan restore`, a restore drill script, metrics and optional Grafana dashboards.
- **Installable web app (PWA)** on desktop and phones that support it.
- **`tincan doctor`** checks DNS, HTTPS, the WebSocket, voice ports, disk, memory and the last backup.

## What does not exist

- **No desktop app.** The installable web app replaces it. That means no global push-to-talk key or mute shortcut, and system audio when screen sharing only where the browser offers it (Windows and ChromeOS).
- **No native mobile apps.** The web app works on a phone browser; voice and camera there are not tested yet.
- **One server per community.** There is no federation and no shared account across servers.
- **SQLite only**, one app process. No Postgres, Redis or S3 yet.
- No two-factor login, no email (invites and password resets are links and codes you hand over), no bots or plugin API, no direct messages.

## Requirements

|          |                                                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine  | Linux (Debian or Ubuntu LTS suggested), x86-64 or arm64, **1 GB RAM minimum, 2 GB comfortable**, 10 GB disk plus space for uploads and backups. Why these numbers: [hosting guide](docs/guides/hosting.md#1-a-vps-with-a-public-ip) |
| Software | Docker Engine 20.10 or newer and the Docker Compose plugin (v2)                                                                                                                                                                     |
| Domain   | A DNS name pointing at the machine (for example `chat.example.com`)                                                                                                                                                                 |
| Ports    | **80/tcp and 443/tcp** (web and certificates), **7881/tcp and 7882/udp** (voice and video). Optional: **5349/tcp and 3478/udp** for the TURN relay, for people behind strict firewalls                                              |
| Network  | A public IPv4 address that really reaches the machine. Home connections behind CGNAT do not work without a relay                                                                                                                    |

Bandwidth matters more than CPU for video: one 1080p screen share watched by five people is roughly 17 Mbit/s out of your server ([docs/08 §5.5](docs/08-voice-video-screenshare.md)).

## Quickstart (a VPS with a domain)

Point your domain's DNS at the server and open the ports above in the provider's firewall and on the machine first ([firewall recipes](docs/guides/hosting.md#4-firewall)). Then, on the server:

```bash
mkdir -p ~/tincan && cd ~/tincan
VERSION=1.0.0    # replace with the newest version on the Releases page
docker run --rm --user "$(id -u):$(id -g)" -e TINCAN_INIT_HOST_DIR="$PWD" -v "$PWD:/out" \
  ghcr.io/goransalzmann/tincan-server:$VERSION \
  node dist/cli.js init --dir /out --domain chat.example.com --email you@example.com \
  --image ghcr.io/goransalzmann/tincan --version $VERSION --yes
docker compose --profile voice up -d
```

`tincan init` writes the configuration, new random secrets, a Compose file, the Caddy configuration and a one-time **setup token**, and prints the token. Then:

1. Open `https://chat.example.com/setup` and paste the setup token (it is also in `data/setup-token` and disappears once the owner exists).
2. Choose the owner's username and password, then log in. You are the owner.
3. In the app, create an invite link and send it to your first member.
4. Check the install: `docker compose exec tincan node dist/cli.js doctor --url https://chat.example.com`. It lists what is wrong and how to fix it.
5. Turn on daily backups: `docker compose --profile backup up -d`. [Read the backup section of the admin guide](docs/guides/admin-guide.md#4-backups-and-restore) before you rely on them.

To try it on your own computer first, without HTTPS or voice: use `--domain localhost` and open `http://localhost:8080/setup`. `tincan doctor` cannot check such a trial from inside the container (it says so); `curl http://localhost:8080/api/v1/capabilities` does the same job.

Building from a git checkout instead of pulling released images: omit `--image` and `--version`, run `pnpm install && pnpm build && pnpm tincan init ...` and start with `docker compose up -d --build`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Guides

- [Hosting guide](docs/guides/hosting.md): server size, home servers, DNS, firewalls, upgrading, troubleshooting.
- [Admin guide](docs/guides/admin-guide.md): moderation, encryption, backups, monitoring, hardening.
- [User guide](docs/guides/user-guide.md): for your members.
- [Design documents](docs/00-index.md): architecture, protocol, security model, roadmap and open questions.
- [Security policy](SECURITY.md) and the [M5 security review](docs/security/m5-review.md).

## Reporting bugs and asking questions

Bugs and ideas go in [GitHub issues](../../issues/new/choose); the bug form asks for the version, `tincan doctor` output and your browser. Questions ("how do I ...") go to [Discussions](../../discussions). **Security problems do not go in public issues:** see [SECURITY.md](SECURITY.md). Pull requests are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first (commits need a `Signed-off-by` line).

## Licence and source

Tin Can is licensed under the [GNU Affero General Public License, version 3 or later](LICENSE). If you run a modified version for other people, the AGPL requires you to offer them your source code: the running server tells every member where the source is (`instance.sourceUrl` in `config.yaml`, which defaults to <https://github.com/GoranSalzmann/TinCan>), so point it at your own fork if you changed anything.
