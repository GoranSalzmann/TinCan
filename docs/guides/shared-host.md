# Sharing the server with other services (Caddy on the host)

By default `tincan init` gives Tin Can's own Caddy container the ports 80 and 443. That is right for a machine that runs only Tin Can. If the machine should host other websites too, move the two ports to a Caddy installed on the host and let Tin Can's container listen on loopback. This is how mkarl.io runs.

```
internet ─► host Caddy (systemd, 80/443/udp 443, all certificates)
              ├─ mkarl.io       ─► 127.0.0.1:8080  Tin Can's web container (plain HTTP, routes and headers as before)
              ├─ turn.mkarl.io  ─► 404 (only so Caddy keeps the certificate LiveKit's TURN/TLS uses)
              └─ other.example  ─► whatever you add: /etc/caddy/conf.d/<name>.caddy
```

## What changes in the Tin Can directory

- `docker-compose.yml`, service `caddy`: `ports:` becomes `"127.0.0.1:8080:8080"`. LiveKit mounts `/var/lib/caddy/.local/share:/caddy:ro` instead of the `caddy-data` volume, so the paths in `livekit.yaml` stay as they are.
- `Caddyfile`: a global block with `auto_https off` and `servers { trusted_proxies static private_ranges }` (the real client address comes from the host Caddy's `X-Forwarded-For`), and the site address `:8080` instead of `{$DOMAIN}`. Routes, headers and the CSP are unchanged; the `{$TURN_DOMAIN}` block moves to the host Caddy.
- `deploy.sh` needs no change: it edits only the `image:` lines.

## Doing it

[deploy/host-caddy/](../../deploy/host-caddy/) has the files and `cutover.sh`, which installs Caddy from the official repository, copies the certificates and ACME account out of the `caddy-data` volume (no new issuance), swaps the files above (a backup is kept in `edge-staging/backup/`), starts the host Caddy and checks `https://<domain>/`; on failure it rolls back (`cutover.sh rollback` does the same later). Copy the directory to `~/tincan/edge-staging/`, change the names in `tincan.caddy`, put the new `Caddyfile` (from `tincan-inner-Caddyfile`) and the edited compose file there as `compose.new`, and run `sudo sh ~/tincan/edge-staging/cutover.sh`. Expect a few seconds of downtime.

## Certificate renewal and LiveKit

Caddy renews about 30 days before expiry; LiveKit reads the certificate only at start. `tincan-livekit-restart.timer` restarts LiveKit on the 1st and 15th at 04:00, which drops active calls for a moment. `tincan voice turn-reload` is the gentler alternative (it waits for empty rooms) if you run it from cron against the host's certificates.

## Adding a service

Write `/etc/caddy/conf.d/<name>.caddy` with its site block and `sudo systemctl reload caddy`. Do not publish its container on 80/443.
