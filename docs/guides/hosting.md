# Tin Can hosting guide (beta)

For the person who sets up and runs the server. The shortest path is the quickstart in the [README](../../README.md); this page explains the choices around it: what machine, where it lives, which ports, how to upgrade, and what to do when something does not work. Day-to-day running (moderation, encryption, backups, metrics) is in the [admin guide](admin-guide.md).

Figures below come from the project's own measurements ([docs/18 §M](../18-open-questions-and-risks.md), run on a desktop computer and one small VPS, not on a range of hosting plans) or from the design documents. Where nothing was measured, this page says so.

## 1. A VPS with a public IP

This is the setup the project is built and tested for: a rented Linux machine with its own public IPv4 address and a domain name.

**Size.** The design target is 1 to 2 vCPUs, 1 to 2 GB of RAM and 10 GB or more of disk ([docs/14 §1](../14-deployment-and-operations.md)). What that rests on:

| What was measured | Result | What it means for you |
|---|---|---|
| 500 connected sockets, held for 20 s | about 190 KiB of memory each, none dropped | Memory is not the limit for a friends group |
| 300 sockets, a tenth reconnecting every few seconds, 10 senders, 20 800 messages, in a container limited to 768 MiB for 6 minutes | no crash, memory flat at 463 to 488 MiB | **1 GB of RAM is the least that is reasonable; 2 GB leaves room** for the database cache, uploads and LiveKit |
| A busy channel with many sessions | about 1 MiB of memory per open session (each keeps the last two minutes of events for reconnecting) | Matters from a few hundred simultaneous sessions, not below |
| One message delivered to 500 listeners | all received in about 0.5 s; one CPU core saturates at roughly 20 000 deliveries per second | A second core helps; chat is not what will fill your CPU |
| Uploads | server memory grows by about 70 MiB at any file size (measured up to 512 MiB) | Disk space and each person's quota are the limits, not RAM |

**Not measured:** how many people one LiveKit can carry on a given plan. That depends on the provider's CPU and bandwidth. Voice itself is light; video is not.

**Bandwidth is the real constraint** ([docs/08 §5.5](../08-voice-video-screenshare.md)): the server sends every stream to every viewer. A ten-person voice call is about 3.6 Mbit/s in total. One 1080p30 screen share watched by five people is about 17.5 Mbit/s, by ten about 35 Mbit/s, which is roughly 15 GB per hour. Look for a plan with a 1 Gbit/s port and generous or unmetered transfer; a monthly 1 TB limit disappears quickly if people share their screens a lot. Owners can lower the camera and screen share caps in Settings › Server › Video quality.

**Disk.** Start with 10 GB plus what you expect people to upload (each person's default quota is 2 GiB, set by the owner under Settings › Server › Uploads) plus room for backups: 14 daily backups of a database and uploads take 14 times their size. Copy backups off the machine ([admin guide §4](admin-guide.md#4-backups-and-restore)).

**Operating system.** Linux, x86-64 or arm64 (released images are built for both); Debian or Ubuntu LTS is what the project uses. Docker Engine 20.10 or newer with the Compose plugin v2. Windows and macOS hosts are for trying things out only: Docker there runs in a virtual machine, which breaks the UDP and host-networking setup voice depends on.

**Before you start:** a domain you control and the ability to open ports in the provider's panel. If the provider says the machine sits behind NAT without a public address of its own, see §2 (CGNAT).

## 2. A home server behind a router

Possible, if you can forward ports and your internet connection gives your router a public IPv4 address.

1. Give the machine a fixed address on your home network (a DHCP reservation in the router is easiest).
2. In the router, forward to that address: **80/tcp, 443/tcp, 7881/tcp, 7882/udp** (and 5349/tcp and 3478/udp if you set up the relay). Forward the same port numbers, not different outside ones: voice announces its ports to the browsers and they must match.
3. Point a DNS name at your public address (§3). If your provider changes the address from time to time, use a dynamic DNS service that updates a record for you (there are many; choose one you trust, this project does not endorse any).
4. Set up the firewall on the machine (§4) and run `tincan doctor` (below).

**Carrier-grade NAT (CGNAT) does not work.** Some providers, mostly mobile and some cable and fibre ones, share one public address between many customers. Then your router's "internet address" is not public, and nobody can connect in; forwarding ports does nothing. Signs:

- the WAN address your router shows is in `100.64.0.0/10` (100.64.x.x to 100.127.x.x), or in `10.x`, `172.16-31.x` or `192.168.x`, or it differs from what a "what is my IP" website shows;
- the web page works from inside your network but not from outside, even though the ports are forwarded;
- `tincan doctor` warns under **Public IP matches** that the name resolves to an address that is not on this machine ([voice-checks](../../apps/server/src/cli/voice-checks.ts)). This is also normal on clouds that give a machine a private address behind a public one, so on its own it proves nothing at home: compare it with the points above. Also, the doctor's media-port line cannot test UDP from the machine itself; check from a phone off Wi-Fi with Settings › Voice › Test connection.

What to do about CGNAT: ask the provider for a public IPv4 address (often free or cheap on request), or host on a VPS instead (§1). **Relay, not tested by this project:** a small VPS with a public address can forward 80, 443, 7881 and 7882/udp through a VPN tunnel (WireGuard, for example) to the machine at home, with `rtc.node_ip` in `livekit.yaml` set to the VPS address. It adds a hop and a second machine to look after, and nobody has run it yet, so a VPS with the whole server on it is the simpler answer.

**From inside your own network** the public name sometimes does not work (the router does not loop traffic back, "hairpin NAT"). Symptom: it works on mobile data and not on your home Wi-Fi. Fix: let your home DNS (the router or a local resolver) answer the name with the machine's LAN address, or switch on NAT loopback in the router if it has the option.

**Home hosting is less forgiving:** the machine must be on, your upload speed limits how many people can watch a screen share at once (see the bandwidth figures in §1), and a power or router outage ends the call.

## 3. DNS

- Create an **A record** (and an AAAA record only if IPv6 really reaches the machine) for the name you will use, for example `chat.example.com`, pointing at the machine's public address. Do this *before* you start Tin Can: Caddy asks Let's Encrypt for a certificate at start and the check needs the name to resolve to this machine.
- If you use a DNS service that can "proxy" traffic (an orange cloud or similar), set the record to **DNS only**. A web proxy cannot carry the UDP media, and it breaks Caddy's certificate check.
- For the optional relay (TURN) add a second name, such as `turn.chat.example.com`, to the same address and give it to `tincan init --turn-domain`. TURN helps people behind firewalls that block UDP; it is **not yet tested on a real host** ([docs/18 §J](../18-open-questions-and-risks.md)).
- Check with `dig +short chat.example.com` (or `nslookup`) from another machine.

## 4. Firewall

Two firewalls can be in the way: the one in the provider's panel and the one on the machine. **Open the ports in both.**

| Port | Protocol | What for | Needed |
|---|---|---|---|
| 22 | TCP | SSH (limit it to your address if you can) | for you |
| 80 | TCP | certificates and redirect to HTTPS | yes |
| 443 | TCP (and UDP for HTTP/3, optional) | the web app, the API, the WebSocket, voice signalling | yes |
| 7881 | TCP | voice media over TCP when UDP is blocked | for voice |
| 7882 | UDP | voice and video media (one port for everyone) | for voice |
| 5349 | TCP | TURN over TLS | only with the relay |
| 3478 | UDP | TURN over UDP | only with the relay |

Keep **3000, 7880, 9090 and 3001 closed**: 3000 is the app, 7880 is LiveKit's admin interface, 9090 and 3001 are the optional dashboards. The generated files already bind them to the machine itself only, and the firewall is a second layer.

**On the machine, ufw (Debian, Ubuntu):**

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
# with the relay: sudo ufw allow 5349/tcp && sudo ufw allow 3478/udp
sudo ufw enable
```

Note that Docker adds its own rules for ports it publishes (here 80 and 443) and ufw does not hide them. That is fine for these two. It is why the generated compose file publishes nothing else to the internet.

**On the machine, firewalld (Fedora, RHEL and relatives):**

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --permanent --add-port=7881/tcp --add-port=7882/udp
sudo firewall-cmd --reload
```

**In the provider's panel:** every provider calls it something different (firewall, security group, network rules, "cloud firewall"). Create an inbound rule per row above, source "any" (`0.0.0.0/0`, and `::/0` if you use IPv6), and attach it to the machine. If voice does not work while everything else does, this is the first place to look.

**At home:** forward the same ports on the router (§2).

Check from *another* machine, for example `nc -vz chat.example.com 7881`. UDP cannot be proven that way; the real test is Settings › Voice › Test connection in the app.

## 5. Installing

Follow the [README quickstart](../../README.md#quickstart-a-vps-with-a-domain). Then run `tincan doctor` (below) and read the [admin guide](admin-guide.md).

**`tincan` on the server** means `docker compose exec tincan node dist/cli.js` run in your install directory (`~/tincan` in the quickstart), for example:

```bash
docker compose exec tincan node dist/cli.js doctor --url https://chat.example.com
```

`doctor` checks the configuration, disk, memory, DNS, HTTPS, the WebSocket, voice (LiveKit reachable, webhook, ports, relay, public address) and the last backup, and prints what to do about each failure. Paste its output into bug reports.

**Released images vs. building from source.** `tincan init --image ghcr.io/goransalzmann/tincan --version X` (what the quickstart does) writes a Compose file that pulls `tincan-server:X` and `tincan-web:X`. Without `--image`, `tincan init` run from a git checkout writes `build:` entries and you start with `docker compose up -d --build`; that is for development.

## 6. Upgrading and rolling back

Read the release notes of every version between yours and the new one: they say if an upgrade needs manual steps.

1. **Back up first**, and copy the archive off the machine: `docker compose exec tincan node dist/cli.js backup --include-secrets --passphrase-file …` ([admin guide §4](admin-guide.md#4-backups-and-restore)). An upgrade that changes the database also takes its own snapshot (`data/backups/pre-migrate-*.db`), but that sits on the same disk.
2. Change the version in `docker-compose.yml`: both `image:` lines, and the `backup` service if you use it (`tincan-server:0.2.0-beta.1` to the new tag).

   ```bash
   sed -i 's/\(tincan-\(server\|web\)\):0\.2\.0-beta\.1/\1:0.2.0-beta.2/' docker-compose.yml
   grep 'image:' docker-compose.yml
   ```

3. `docker compose pull && docker compose up -d`. Then `docker compose logs --tail 50 tincan` and `tincan doctor`.
4. LiveKit is a separate image with its own pinned version. A Tin Can release says if it needs a newer one; restarting LiveKit ends running calls, so do it when nobody is in one.

**Rolling back.** An older version refuses to start on a database a newer version has changed. That is on purpose, so nothing is damaged. To go back: stop (`docker compose down`), restore the pre-upgrade backup into a new directory (`tincan restore`, or copy the matching `pre-migrate-….db` over `data/app.db` while stopped), set the previous tags, `docker compose up -d`. Everything written after the backup is lost, so decide early. This path was rehearsed with a real previous release ([admin guide §5](admin-guide.md#5-upgrade-and-rollback)).

Beta tags (`-beta.N`) never move `latest`. The generated files pin an exact version on purpose; you decide when to upgrade.

## 7. Troubleshooting

Start with `tincan doctor` and `docker compose ps`. Logs: `docker compose logs --tail 100 tincan` (or `caddy`, `livekit`). An error in the app carries a request id; `docker compose logs tincan | grep <id>` finds the lines.

| What you see | Likely cause | What to do |
|---|---|---|
| Joining a voice channel works but nobody hears anyone, or "Test connection" fails | **UDP 7882** is blocked in the provider's firewall or on the machine; or the router does not forward it | Open 7882/udp in both firewalls (§4). Also open 7881/tcp, the fallback. Retest from another network |
| Voice works on mobile data but not at home or at work | A network that blocks UDP | Open 7881/tcp; set up the TURN relay (`--turn-domain`, 5349/tcp and 3478/udp) |
| No certificate; the browser warns, or Caddy logs an ACME error | **Port 80** is closed, or the DNS name does not point at this machine yet, or a DNS proxy sits in front | Fix DNS (§3), open 80 and 443, then `docker compose restart caddy`. Let's Encrypt limits repeated failures; wait before retrying many times |
| "This call is end-to-end encrypted and this browser cannot join it" | An old browser, or one without the needed encryption support | Use a current Chrome or Edge (Firefox is expected to work, Safari untested); or set the channel to Never encrypt |
| `tincan doctor` fails on the internal webhook path | The Caddyfile does not answer 404 for `/api/internal/*` and `/api/v1/internal/*` | Restore the Caddyfile `@internal` lines from a fresh `tincan init` |
| Reconciler repairs keep rising; people stay in a voice channel after leaving | LiveKit's webhook cannot reach the app | Check `webhook.urls` in `livekit.yaml` (`http://127.0.0.1:3000/api/v1/internal/livekit/webhook`) and that the app container publishes `127.0.0.1:3000` |
| The app cannot reach LiveKit ("Voice server reachable" fails) | LiveKit is not running (it is in the `voice` profile), or `docker0` is not `172.17.0.1` on your host | `docker compose --profile voice up -d`. Check the bridge address with `ip addr show docker0` and, if different, run `tincan init --host-gateway-ip <address>` in a new folder to compare the generated files |
| "Public IP matches" warns | Normal on clouds that NAT a public address. At home it may be CGNAT | See §2 |
| `permission denied` writing to `data/` | The folder is owned by another user than the one in `HOST_UID`/`HOST_GID` of `.env` | `sudo chown -R "$(id -u):$(id -g)" data` or fix the two values in `.env` |
| `docker compose` complains about unknown keys, `name` or `profiles` | Compose v1 (`docker-compose`) or a very old plugin | Install the Compose plugin v2; `tincan init` warns when it sees an old one |
| The setup page asks for a token you no longer have | The token is in `data/setup-token` until the owner exists | `cat data/setup-token`, or create the owner on the command line: `tincan setup --username you` |
| Login says "banned" or "try again later" | A ban or the login rate limit (10 attempts per 15 minutes per address, 5 per name) | Wait; or lift the ban in Settings › Moderation |
| Upload fails with 429 and "busy" | Many large images are being processed at once (memory budget) | Retry in a few seconds; raise `modules.uploads.memoryBudgetBytes` only with RAM to spare |
| Every call restarts when you change a setting | By design: changing the encryption mode restarts the call | Change it when nobody is in a call |
| An old version will not start after a rollback attempt | The database is newer than that version knows | Restore the pre-upgrade backup (§6) |
| Prometheus shows the app as down | The metrics token differs between `.env` and `monitoring/metrics-token` | Make them equal and restart |
| It works from outside but not from your own network | No NAT loopback ("hairpin") on a home router | §2 |

If it is none of these, open an issue with the bug form: it asks for the version, `doctor` output and your browser, and that is usually enough to find it.
