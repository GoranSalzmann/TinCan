#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs inside the scratch machine of rehearse.sh, as an ordinary user in the docker group.
set -eu

step() { printf '\n--- %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok:   %s\n' "$*"; }

REG=localhost:5000
DIR=$HOME/tincan
export TINCAN_DIR="$DIR" IMAGE_BASE="$REG/tincan" PROFILES=backup HEALTH_TIMEOUT=120
export PASSPHRASE_FILE="$HOME/.tincan-backup-key" TINCAN_DEPLOY_LOG="$HOME/tincan-deploy.log"

step "0. A registry, a release (1.0.0) and a broken release (1.0.1-broken) in it"
docker run -d --name registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null
i=0
until curl -fsS -m 2 "http://$REG/v2/" >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -le 30 ] || fail "no registry"; sleep 1; done
docker tag tincan-server "$REG/tincan-server:1.0.0"
docker tag tincan-web "$REG/tincan-web:1.0.0"
docker tag tincan-server:broken "$REG/tincan-server:1.0.1-broken"
docker tag tincan-web "$REG/tincan-web:1.0.1-broken"
for t in server:1.0.0 web:1.0.0 server:1.0.1-broken web:1.0.1-broken; do docker push -q "$REG/tincan-${t%%:*}:${t#*:}" >/dev/null; done
# The host must not have the release images yet, as on mkarl.io.
docker rmi -f "$REG/tincan-server:1.0.0" "$REG/tincan-web:1.0.0" "$REG/tincan-server:1.0.1-broken" "$REG/tincan-web:1.0.1-broken" >/dev/null
ok "pushed"

step "1. An installation that builds from source, with an encrypted backup key"
mkdir -p "$DIR"
(cd "$DIR" && docker run --rm --user "$(id -u):$(id -g)" -e TINCAN_INIT_HOST_DIR="$DIR" -v "$DIR:/out" tincan-server \
  node dist/cli.js init --dir /out --domain localhost --image local/tincan --version 1.0.0 --yes >/dev/null)
# What a checkout install looks like: local images and build: blocks (the hand-patched host of docs/guides/deploy.md §6).
sed -i -e 's#image: local/tincan-server:1.0.0#image: tincan-server#' -e 's#image: local/tincan-web:1.0.0#image: tincan-web#' "$DIR/docker-compose.yml"
awk '/^  tincan:$/ || /^  caddy:$/ { print; print "    build:"; print "      context: ../tincan-src"; print "      dockerfile: deploy/Dockerfile"; print "      target: x"; next } { print }' \
  "$DIR/docker-compose.yml" > "$DIR/compose.new" && mv "$DIR/compose.new" "$DIR/docker-compose.yml"
sed -i 's|^    ports:|    # a setting the host added by hand\n    ports:|' "$DIR/docker-compose.yml"
head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$PASSPHRASE_FILE"
chmod 600 "$PASSPHRASE_FILE"
[ "$(grep -c 'context: ../tincan-src' "$DIR/docker-compose.yml")" = 2 ] || fail "the scratch compose file is not as intended"
cd "$DIR"
docker compose --profile backup up -d --no-build >/dev/null
i=0
until curl -fsS -m 3 http://127.0.0.1:3000/readyz >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -le 45 ] || fail "not ready"; sleep 2; done
printf '%s\n' "the-password-for-rehearsal" | docker compose exec -T tincan node dist/cli.js setup --username owner --display-name Owner --password-stdin >/dev/null
docker compose restart tincan >/dev/null
sleep 5
ok "running from local images (owner created)"

step "2. First deploy of the release image, through the forced-command entry"
SSH_ORIGINAL_COMMAND="deploy 1.0.0" sh "$HOME/deploy.sh"
docker compose ps --format '{{.Service}} {{.Image}}'
grep -q "image: $REG/tincan-server:1.0.0" docker-compose.yml || fail "compose does not point at the release image"
if grep -q 'build:' docker-compose.yml; then fail "a build: block is left"; fi
grep -q 'a setting the host added by hand' docker-compose.yml || fail "the host's own setting was lost"
curl -fsS -m 5 http://127.0.0.1:3000/api/v1/capabilities | grep -q '"setupRequired":false' || fail "the owner is gone"
ls data/backups/tincan-backup-*.enc >/dev/null 2>&1 || fail "the pre-deploy backup is not encrypted"
ok "migrated to the release image; owner, host setting and encrypted backup in place"

step "3. A release that never becomes healthy: rolled back, data kept"
rc=0
HEALTH_TIMEOUT=25 sh "$HOME/deploy.sh" 1.0.1-broken || rc=$?
[ "$rc" = 10 ] || fail "expected exit 10 (rolled back), got $rc"
grep -q "image: $REG/tincan-server:1.0.0" docker-compose.yml || fail "compose was not put back"
curl -fsS -m 5 http://127.0.0.1:3000/api/v1/capabilities | grep -q '"setupRequired":false' || fail "the owner is gone after the rollback"
ok "exit 10, previous version running again"

step "4. A release that does not exist: nothing changes"
rc=0
sh "$HOME/deploy.sh" 9.9.9 || rc=$?
[ "$rc" = 6 ] || fail "expected exit 6 (pull failed), got $rc"
grep -q "image: $REG/tincan-server:1.0.0" docker-compose.yml || fail "compose changed"
ok "exit 6, nothing changed"

step "5. The same release again, and a hostile argument"
sh "$HOME/deploy.sh" 1.0.0
rc=0
SSH_ORIGINAL_COMMAND='deploy 1.0.0; touch /tmp/pwned' sh "$HOME/deploy.sh" || rc=$?
[ "$rc" = 2 ] && [ ! -e /tmp/pwned ] || fail "the hostile argument was not refused"
ok "re-deploy works; shell metacharacters refused"

step "6. Log"
tail -n 5 "$TINCAN_DEPLOY_LOG"
printf '\nPASS: deploy rehearsal (local build to release image, rollback, failed pull, re-deploy).\n'
