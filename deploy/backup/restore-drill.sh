#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Proves that your newest backup can be restored: unpacks it into a scratch directory, starts a throw-away Tin Can
# on it (plain HTTP on 127.0.0.1, another port, no voice, its own random secret) and checks that it answers and
# knows the owner. The live instance is never touched: nothing here writes to its data directory, its containers or
# its ports. Run it on the server, from the deployment directory, now and then (once a month is a good habit).
#
#   sh restore-drill.sh                       # newest backup in ./data/backups
#   BACKUP=/path/to/archive PASSPHRASE_FILE=/path/to/key sh restore-drill.sh
#
# Environment: TINCAN_DIR (default .), BACKUP, PASSPHRASE_FILE (for encrypted archives), PORT (default 3999),
# IMAGE (default tincan-server, the image the compose file built), RUN_AS (uid:gid the containers run as; default your
# own, which is what owns the backups; set 0:0 only where Docker does not map file owners, e.g. Docker Desktop).
set -eu

dir=${TINCAN_DIR:-.}
port=${PORT:-3999}
image=${IMAGE:-tincan-server}
backup=${BACKUP:-}
if [ -z "$backup" ]; then
  backup=$(ls -1 "$dir"/data/backups/tincan-backup-*.tar.gz* 2>/dev/null | sort | tail -n 1 || true)
fi
[ -n "$backup" ] && [ -f "$backup" ] || { echo "FAIL: no backup found (set BACKUP=<file>)" >&2; exit 1; }
backup=$(cd "$(dirname "$backup")" && pwd)/$(basename "$backup")

scratch=$(mktemp -d "${TMPDIR:-/tmp}/tincan-drill-XXXXXX")
name="tincan-drill-$$"
uidgid=${RUN_AS:-$(id -u):$(id -g)}
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM
chmod 700 "$scratch"

echo "Backup:  $backup"
echo "Scratch: $scratch (removed at the end)"

pass_args=""
if [ -n "${PASSPHRASE_FILE:-}" ]; then
  cp "$PASSPHRASE_FILE" "$scratch/passphrase"
  chmod 600 "$scratch/passphrase"
  pass_args="-v $scratch/passphrase:/passphrase:ro -e TINCAN_BACKUP_PASSPHRASE_FILE=/passphrase"
fi

echo "1/3 Restoring (checks every checksum, the database and its row counts) ..."
# shellcheck disable=SC2086  # pass_args is a list of flags on purpose
docker run --rm -u "$uidgid" $pass_args \
  -v "$(dirname "$backup"):/backups:ro" -v "$scratch:/scratch" \
  "$image" node dist/cli.js restore "/backups/$(basename "$backup")" --into /scratch/restored

echo "2/3 Starting a throw-away server on 127.0.0.1:$port ..."
secret=$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')
cat > "$scratch/config.yaml" <<YAML
instance:
  name: Restore drill
  publicUrl: http://127.0.0.1:$port
server: { host: 0.0.0.0, port: 3000, trustProxy: false }
dataDir: /data
adapters:
  database: { kind: sqlite, path: /data/app.db }
  storage: { kind: local, path: /data/files }
  pubsub: { kind: memory }
  auth: { kinds: [local] }
log: { level: warn }
YAML
docker run -d --name "$name" -u "$uidgid" -p "127.0.0.1:$port:3000" \
  -v "$scratch/restored/data:/data" -v "$scratch/config.yaml:/config/config.yaml:ro" \
  -e TINCAN_CONFIG=/config/config.yaml -e "TINCAN_SECURITY__INSTANCE_SECRET=$secret" \
  "$image" >/dev/null

echo "3/3 Waiting for it to answer ..."
i=0
until curl -fsS -m 3 "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 40 ]; then
    echo "FAIL: the restored server did not become ready in 80 s. Its log:" >&2
    docker logs --tail 30 "$name" >&2 || true
    exit 1
  fi
  sleep 2
done
caps=$(curl -fsS -m 5 "http://127.0.0.1:$port/api/v1/capabilities")
case "$caps" in
  *'"setupRequired":false'*) ;;
  *) echo "FAIL: the restored server asks for first-run setup, so it holds no owner: $caps" >&2; exit 1 ;;
esac
echo "$caps" | grep -o '"features":{[^}]*' | head -c 200 >/dev/null 2>&1 || true

echo
echo "PASS: $(basename "$backup") restored, the database is intact and a server started on it knows its owner."
echo "      (Row counts were compared with the backup's manifest in step 1.)"
