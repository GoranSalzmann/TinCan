#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs inside the fresh Ubuntu machine as an ordinary user (see run.sh). The README's quickstart block is extracted and
# executed, so the test breaks when the README does. Substitutions, each checked afterwards:
#   domain          chat.example.com -> localhost (plain HTTP on port 8080, no certificates)
#   image           ghcr.io/goransalzmann/tincan* -> the local images run.sh loaded (there is no release to pull yet)
#   --email         dropped (a trial has no certificate)
#   --profile voice dropped (needs a public IP and open UDP ports; the media test covers voice)
set -eu

IMAGE=${IMAGE:?}
TAG=${TAG:?}
PASSWORD=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n') # a new random one for each run
BASE=http://localhost:8080

step() { printf '\n--- %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok:   %s\n' "$*"; }

step "1. The README quickstart, as written"
awk '/^## Quickstart/ { q = 1 } q && /^```bash/ { b = 1; next } b && /^```/ { exit } b { print }' README.md > quickstart.raw
[ -s quickstart.raw ] || fail "no bash block found under '## Quickstart' in README.md"
sed -e "s#^VERSION=[^ ]*#VERSION=$TAG#" \
    -e "s#ghcr.io/goransalzmann/tincan-server#$IMAGE-server#" \
    -e "s#--image ghcr.io/goransalzmann/tincan#--image $IMAGE#" \
    -e "s#chat.example.com#localhost#g" \
    -e "s# --email you@example.com##" \
    -e "s# --profile voice##" quickstart.raw > quickstart.sh
if grep -n 'ghcr.io\|example.com\|profile voice' quickstart.sh; then fail "the quickstart has a part this test does not know how to adapt"; fi
cat quickstart.sh
echo
sh -eu quickstart.sh
cd "$HOME/tincan"
ls -la
[ -s data/setup-token ] || fail "init did not leave data/setup-token"
ok "init wrote the files and the setup token"

step "2. The server comes up"
i=0
until curl -fsS -m 3 http://127.0.0.1:3000/readyz >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 45 ]; then
    docker compose ps
    docker compose logs --tail 40 tincan
    fail "/readyz did not answer within 90 seconds"
  fi
  sleep 2
done
ok "/readyz"
curl -fsS -m 3 http://127.0.0.1:3000/healthz >/dev/null && ok "/healthz"
caps=$(curl -fsS -m 5 "$BASE/api/v1/capabilities")
echo "$caps" | jq -e '.auth.setupRequired == true' >/dev/null || fail "capabilities should say setup is required: $caps"
ok "the proxy answers /api/v1/capabilities (version $(echo "$caps" | jq -r .server.version), setup required)"
curl -fsS -m 5 "$BASE/" | grep -qi '<title>' && ok "the web client is served on $BASE/"

step "3. Create the owner from the command line"
printf '%s\n' "$PASSWORD" | docker compose exec -T tincan node dist/cli.js setup --username owner --display-name Owner --password-stdin
[ ! -e data/setup-token ] || fail "the setup token should be removed once the owner exists"
ok "owner created, setup token removed"
# The CLI path writes the owner to the database behind the running server's back; the server picks it up on start.
docker compose restart tincan
i=0
until curl -fsS -m 3 http://127.0.0.1:3000/readyz >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -le 30 ] || fail "the server did not come back after the restart"; sleep 2
done

step "4. Log in over HTTP and send a message"
login=$(curl -fsS -m 10 -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"owner\",\"password\":\"$PASSWORD\"}") || fail "login failed"
token=$(echo "$login" | jq -er .token)
auth="Authorization: Bearer $token"
channel=$(curl -fsS -m 10 "$BASE/api/v1/channels" -H "$auth" | jq -er '[.channels[] | select(.type == "text")][0].id') \
  || fail "no text channel found"
ok "logged in; text channel $channel"
msg=$(curl -fsS -m 10 -X POST "$BASE/api/v1/channels/$channel/messages" -H "$auth" -H 'Content-Type: application/json' \
  -d '{"content":"hello from the clean-install test"}') || fail "sending a message failed"
echo "$msg" | jq -e '.content == "hello from the clean-install test"' >/dev/null || fail "unexpected message reply: $msg"
curl -fsS -m 10 "$BASE/api/v1/channels/$channel/messages" -H "$auth" | jq -e 'map(.content) | index("hello from the clean-install test")' >/dev/null \
  || fail "the message is not in the channel history"
ok "message sent and read back"

step "5. tincan doctor"
# Inside the container, `localhost` is the container itself, so a trial's own URL cannot be reached from here; doctor says
# so (and the checks above did the same job with curl). A real install passes --url with its public https address.
doctor_out=$(docker compose exec -T tincan node dist/cli.js doctor --no-voice 2>&1) || true
echo "$doctor_out"
for line in 'Configuration' 'Data directory writable' 'Disk space'; do
  echo "$doctor_out" | grep -qF "[ok]  $line" || fail "doctor should report '$line' as ok"
done
echo "$doctor_out" | grep -q 'this container itself' || fail "doctor should explain that a localhost URL cannot be checked from the container"
ok "doctor ran and explained what it cannot check from inside the container"

step "6. Backup and restore"
docker compose exec -T tincan node dist/cli.js backup --out /data/backups
archive=$(ls -1 data/backups/tincan-backup-*.tar.gz | tail -n 1)
[ -n "$archive" ] || fail "no archive in data/backups"
tar -tzf "$archive" | head -n 8
ok "backup written: $archive"
# The shipped restore drill: restores into a scratch folder, starts a throw-away server on it, asks it for the owner.
TINCAN_DIR="$HOME/tincan" IMAGE="$IMAGE-server:$TAG" sh "$HOME/restore-drill.sh"
# And the restored database really holds the message sent above.
mkdir -p "$HOME/restored-out"
docker run --rm -u "$(id -u):$(id -g)" -v "$HOME/tincan/data/backups:/backups:ro" -v "$HOME/restored-out:/out" \
  "$IMAGE-server:$TAG" node dist/cli.js restore "/backups/$(basename "$archive")" --into /out/restored
count=$(sqlite3 -readonly "$HOME/restored-out/restored/data/app.db" "select count(*) from message where content = 'hello from the clean-install test'")
[ "$count" = 1 ] || fail "the restored database should hold the test message once, found $count"
ok "restored database holds the message"

step "7. Still healthy after all that"
curl -fsS -m 3 http://127.0.0.1:3000/readyz >/dev/null && ok "/readyz"
printf '\nPASS: the README quickstart gives a working server (owner, login, message, doctor, backup and restore).\n'
