# The TURN relay: voice behind strict firewalls

Voice and video normally flow straight between a person's device and your server over **7882/udp** (or **7881/tcp** when UDP is blocked). Some networks (schools, offices, some mobile carriers, some VPNs) block UDP _and_ do not let anything but port 443 through to unknown hosts. For those people the **TURN relay** inside LiveKit carries the media over TLS on **5349/tcp**. Without it they join the call and hear nothing.

This page is the exact list of what the relay needs, how to switch it on for an existing installation, and how to prove it works. It is written from the point of view of the person who runs the server.

## 1. What it needs

| Thing | Value | Why |
|---|---|---|
| A second DNS name | `turn.<your domain>`, an A record to the same address as the main name (DNS only, no proxy). A wildcard record `*.<your domain>` also does it | LiveKit's TURN/TLS presents a certificate, and a certificate needs its own name |
| A certificate | Obtained by **Caddy** for that name (a site block that answers 404), read by LiveKit from the shared `caddy-data` volume | One ACME client, no extra tool. Needs 80/tcp and 443/tcp, which you already have |
| **5349/tcp** | open in the host **and** provider firewall | TURN over TLS: the path for people who can only use TCP |
| **3478/udp** | open in the host **and** provider firewall | TURN over UDP (also answers STUN): the path for people whose UDP works but who are behind a NAT that needs a relay |
| The relay port range (default 30000–40000/udp) | **stays closed** | Tin Can's media server is on the same machine as the relay, so relayed packets never leave it. Only open it if the check in §4 shows relay-only calls failing and the LiveKit log shows relayed packets never arriving |
| Order of steps | Caddy gets the certificate **before** LiveKit is told to use it | LiveKit refuses to start when the certificate file is missing |

Already built in: `tincan init --turn-domain turn.example.com` writes all of this for a new installation (Caddy site, `TURN_DOMAIN`, the `turn:` block, the read-only volume). For an installation made before, §2 adds the same lines by hand.

## 2. Switch it on for an existing installation

`tincan voice turn-snippets --turn-domain turn.example.com` prints the lines below with your name filled in.

1. **DNS**: make `turn.example.com` resolve to this machine (`dig +short turn.example.com`).
2. `.env`: set `TURN_DOMAIN=turn.example.com`.
3. `Caddyfile`: add at the end

   ```
   {$TURN_DOMAIN} {
   	respond 404
   }
   ```

   then `docker compose up -d caddy` and wait until `docker compose logs caddy | grep turn.example.com` says the certificate was obtained.
4. `livekit.yaml`: replace the `turn:` block (`enabled: false`) with the one `turn-snippets` prints (domain, `tls_port: 5349`, `udp_port: 3478`, the two certificate paths).
5. Restart LiveKit: `docker compose --profile voice up -d livekit`. **This drops every call in progress**, so do it when nobody is talking.
6. **Open 5349/tcp and 3478/udp** in the host and provider firewalls (§3).
7. Verify (§4).

Certificates renew about every 60 days and LiveKit reads them only at start: run `tincan voice turn-reload --turn-domain turn.example.com` daily from cron (it restarts LiveKit only when no call is running, or within 7 days of expiry).

## 3. What you must do outside Tin Can

Tin Can never touches your DNS or firewall.

- [ ] **DNS**: `turn.<domain>` → the server's address (nothing to do if you already have a wildcard record that points there).
- [ ] **Provider firewall** (cloud panel, if there is one): allow inbound **5349/tcp** and **3478/udp** from anywhere.
- [ ] **Host firewall**: for ufw, `sudo ufw allow 5349/tcp` and `sudo ufw allow 3478/udp`. Keep 3000, 7880, 9090, 3001 closed.
- [ ] Do not put the TURN name behind a web proxy (an orange cloud).

## 4. Verify it

Three layers, from cheapest to most real.

**a. `tincan doctor --turn-domain turn.example.com`.** `Relay (TURN/TLS 5349)` is ok when the certificate is for the name and a TURN Allocate request (without credentials) is answered with 401 over TLS. `Relay (TURN/UDP 3478)` does the same over UDP; run on the server itself it can only say "warn" because the packet may never leave the machine. Run it from **another machine** for a real answer (the check then says ok).

**b. `pnpm turn-test`: real media through the relay.** It joins a throwaway room from headless Chromium with ICE restricted to relay candidates and reads which candidate pair the browser selected:

```bash
# on the server: a token for a throwaway room that lasts 10 minutes and cannot publish
docker compose exec -T tincan node dist/cli.js voice test-token --url https://chat.example.com > token.json
# on any other machine with the repository built (pnpm install && pnpm build):
pnpm turn-test --token-file token.json
```

It prints one line per mode: `direct` (baseline), `relay` (every TURN URL), `relay-udp` (only 3478/udp), `relay-tls` (only 5349/tcp, the UDP-blocked case). Each passes only when the selected pair really is a relay candidate on the expected protocol. `relay-tls` restricts the _ICE configuration_, not the network: it proves the TLS path works from where you ran it. For the full effect, run the test from a network that blocks UDP.

**c. The in-app test.** Settings → Voice & audio → Test connection, from a network that blocks UDP (a phone hotspot with a firewall, an office, a VPN that only carries TCP). The `relay` step goes green when TURN carried the call.

## 5. Results on mkarl.io

See [qa/turn.md](../qa/turn.md) for what was run, from where, and what is still untested.
