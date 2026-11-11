#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Moves ports 80/443 from Tin Can's Caddy container to a Caddy installed on the host.
# Run on the server:  sudo sh ~/tincan/edge-staging/cutover.sh        (rollback: ... cutover.sh rollback)
set -eu
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
U=${SUDO_USER:?run it with sudo, from your own user}
T=/home/$U/tincan
S=$T/edge-staging
CERTS=/var/lib/caddy/.local/share/caddy
as_user() { runuser -u "$U" -- "$@"; }
dc() { (cd "$T" && as_user docker compose --profile voice --profile dashboards --profile backup "$@"); }

rollback() {
  echo "== rolling back =="
  systemctl stop caddy 2>/dev/null || true
  as_user cp "$S/backup/Caddyfile" "$T/Caddyfile"
  as_user cp "$S/backup/docker-compose.yml" "$T/docker-compose.yml"
  dc up -d caddy livekit
  echo "rolled back: Tin Can's own Caddy owns 80/443 again"
}
[ "${1:-}" != rollback ] || { rollback; exit 0; }

echo "== 1. install Caddy (official repo) without starting it =="
if ! command -v caddy >/dev/null; then
  printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  rm -f /usr/sbin/policy-rc.d
fi
caddy version

echo "== 2. config =="
mkdir -p /etc/caddy/conf.d
[ ! -f /etc/caddy/Caddyfile ] || cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.dist
install -m 644 "$S/host-Caddyfile" /etc/caddy/Caddyfile
install -m 644 "$S/tincan.caddy" /etc/caddy/conf.d/tincan.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "== 3. copy certificates and ACME account from the container's volume =="
mkdir -p "$CERTS"
as_user docker run --rm -v tincan_caddy-data:/src:ro -v /var/lib/caddy/.local/share:/dst alpine sh -c 'cp -a /src/caddy/. /dst/caddy/'
chown -R caddy:caddy /var/lib/caddy
ls "$CERTS/certificates/acme-v02.api.letsencrypt.org-directory"

echo "== 4. back up and swap Tin Can's files =="
as_user mkdir -p "$S/backup"
as_user cp "$T/Caddyfile" "$T/docker-compose.yml" "$S/backup/"
as_user cp "$S/tincan-inner-Caddyfile" "$T/Caddyfile"
as_user cp "$S/compose.new" "$T/docker-compose.yml"
dc config -q || { rollback; exit 1; }

echo "== 5. cutover (mkarl.io is down from here for a few seconds) =="
dc up -d caddy                      # recreated without 80/443
systemctl enable --now caddy
ok=
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  if curl -fsS -o /dev/null --max-time 5 https://mkarl.io/ ; then ok=1; break; fi
done
[ -n "$ok" ] || { echo "https://mkarl.io/ did not answer"; rollback; exit 1; }

echo "== 6. LiveKit: new certificate mount, plus a timer that restarts it twice a month =="
dc up -d livekit
install -m 644 "$S/tincan-livekit-restart.service" "$S/tincan-livekit-restart.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tincan-livekit-restart.timer

echo "== done. Tell Claude; it will run the checks =="
