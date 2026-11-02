#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Deploys one released version of Tin Can to this machine (docs/14 §7, docs/guides/deploy.md). Run by the deploy
# workflow over ssh as a forced command, or by hand:
#
#   sh deploy.sh 1.0.1
#
# What it does, in order; any failure before step 5 leaves the running server untouched:
#   1. validates the version (strict semver) and takes a lock, so two deploys never overlap;
#   2. takes a backup with the RUNNING version, then restores it into a scratch directory to prove it opens;
#   3. pulls both images by version (nothing has changed yet if this fails);
#   4. edits docker-compose.yml: only the image: lines of tincan-server and tincan-web (the backup service too) are set,
#      any build: block of those services is dropped, everything else the host has changed stays; a copy is kept;
#   5. docker compose up -d, waits until the server is healthy AND reports the new version, then runs `tincan doctor` and
#      fails only on checks that did not already fail before the deploy;
#   6. on failure: the old compose file and images come back. If the old version refuses to start because a migration
#      changed the database, the pre-migration snapshot (or else the backup) is put back and the output says how much
#      data was lost.
#
# Exit codes (the Actions run fails on any non-zero one):
#   0 deployed        2 bad usage or version   3 another deploy is running   4 preflight failed (nothing changed)
#   5 backup failed (nothing changed)          6 image pull failed (nothing changed)
#   10 new version failed, rolled back to the old one, no data lost
#   11 new version failed, the database was restored, data written since the snapshot is lost (see the output)
#   12 new version failed and the rollback failed too: the server needs a person (see the log)
#
# Environment (all optional): TINCAN_DIR (default ~/tincan), IMAGE_BASE (ghcr.io/goransalzmann/tincan),
# PASSPHRASE_FILE (~/.tincan-backup-key: the path is passed to the backup container, the file is never read here),
# PROFILES ("voice dashboards backup"), HEALTH_TIMEOUT (seconds, 180), TINCAN_DEPLOY_LOG (~/tincan-deploy.log),
# DOCKER, CURL, TINCAN_DEPLOY_POLL (the commands and the polling interval, for tests).
set -u

# An ssh connection that drops must not kill a deploy half way.
trap '' HUP PIPE

DIR=${TINCAN_DIR:-$HOME/tincan}
IMAGE_BASE=${IMAGE_BASE:-ghcr.io/goransalzmann/tincan}
PASSPHRASE_FILE=${PASSPHRASE_FILE:-$HOME/.tincan-backup-key}
PROFILES=${PROFILES:-voice dashboards backup}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}
LOG=${TINCAN_DEPLOY_LOG:-$HOME/tincan-deploy.log}
DOCKER=${DOCKER:-docker}
CURL=${CURL:-curl}
PORT=${TINCAN_PORT:-3000}
POLL=${TINCAN_DEPLOY_POLL:-3}
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'

log() {
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$LOG" 2>/dev/null || true
}
die() {
  code=$1
  shift
  log "ERROR: $*"
  exit "$code"
}

# Runs a command, shows and logs its output indented, returns its status. The output is also left in $RUN_OUT.
RUN_OUT=
run() {
  RUN_OUT=$(mktemp "${TMPDIR:-/tmp}/tincan-deploy-out-XXXXXX")
  "$@" >"$RUN_OUT" 2>&1
  rc=$?
  sed 's/^/    | /' "$RUN_OUT" | tee -a "$LOG" 2>/dev/null
  return $rc
}

# ---- 1. the version -------------------------------------------------------------------------------------------------
raw=${1:-}
if [ -z "$raw" ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # Forced command: the client may only say "deploy <version>" or "<version>".
  raw=${SSH_ORIGINAL_COMMAND#deploy }
fi
if [ "$raw" = hash ]; then
  # Lets the deploy workflow warn when the copy of this script on the host is not the one in the repository.
  sha256sum "$0" | cut -d" " -f1
  exit 0
fi
case $raw in
  *'
'*) die 2 "the version must be one line" ;;
esac
[ "${#raw}" -le 64 ] || die 2 "the version is too long"
version=${raw#v}
printf '%s\n' "$version" | grep -Eq "$SEMVER" || die 2 "\"$raw\" is not a version like 1.2.3 or 1.2.3-rc.1"

# ---- lock -----------------------------------------------------------------------------------------------------------
[ -d "$DIR" ] && [ -f "$DIR/docker-compose.yml" ] && [ -f "$DIR/.env" ] || die 4 "$DIR is not a Tin Can directory (no docker-compose.yml or .env)"
LOCKDIR=$DIR/.deploy.lock
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  other=$(cat "$LOCKDIR/pid" 2>/dev/null || true)
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    die 3 "another deploy is running (pid $other)"
  fi
  log "removing the lock of a deploy that no longer runs (pid ${other:-unknown})"
  rm -rf "$LOCKDIR"
  mkdir "$LOCKDIR" 2>/dev/null || die 3 "could not take the lock $LOCKDIR"
fi
echo $$ >"$LOCKDIR/pid"
SCRATCH=
# shellcheck disable=SC2329  # called by the EXIT trap
cleanup() {
  [ -z "$SCRATCH" ] || rm -rf "$SCRATCH"
  [ -z "$RUN_OUT" ] || rm -f "$RUN_OUT"
  rm -rf "$LOCKDIR"
}
trap cleanup EXIT
trap 'exit 143' TERM INT

log "== Deploy $version to $DIR (pid $$, $(id -un)) =="
cd "$DIR" || die 4 "cannot enter $DIR"

profile_args=
for p in $PROFILES; do profile_args="$profile_args --profile $p"; done
# shellcheck disable=SC2086  # profile_args is a list of flags on purpose
compose() { $DOCKER compose $profile_args "$@"; }

env_value() { sed -n "s/^$1=//p" .env | head -n 1; }

new_server=$IMAGE_BASE-server:$version
new_web=$IMAGE_BASE-web:$version

# ---- preflight ------------------------------------------------------------------------------------------------------
$DOCKER info >/dev/null 2>&1 || die 4 "cannot talk to Docker (is the deploy user in the docker group?)"
compose config -q >/dev/null 2>&1 || die 4 "the current docker-compose.yml is not valid ('docker compose config' fails); not touching anything"
current_server=$(sed -n 's/^    image:[[:space:]]*\([^[:space:]]*tincan-server[^[:space:]]*\)[[:space:]]*$/\1/p' docker-compose.yml | head -n 1)
current_web=$(sed -n 's/^    image:[[:space:]]*\([^[:space:]]*tincan-web[^[:space:]]*\)[[:space:]]*$/\1/p' docker-compose.yml | head -n 1)
[ -n "$current_server" ] && [ -n "$current_web" ] || die 4 "no image: line for tincan-server and tincan-web in docker-compose.yml"
log "now:    $current_server  $current_web"
log "target: $new_server  $new_web"

uid=$(env_value HOST_UID)
gid=$(env_value HOST_GID)
uidgid=${uid:-$(id -u)}:${gid:-$(id -g)}

# The containers get the passphrase file by path; this script never reads it.
pass=
[ ! -f "$PASSPHRASE_FILE" ] || pass="-v $PASSPHRASE_FILE:/run/backup-passphrase:ro -e TINCAN_BACKUP_PASSPHRASE_FILE=/run/backup-passphrase"

running_image() {
  cid=$(compose ps -q tincan 2>/dev/null | head -n 1)
  [ -n "$cid" ] && $DOCKER inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null
}

# Waits for the server to be healthy (and to say it is $1, unless empty). Returns 0 or 1.
wait_ready() {
  want=$1
  waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    cid=$(compose ps -q tincan 2>/dev/null | head -n 1)
    state=
    [ -z "$cid" ] || state=$($DOCKER inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)
    if [ "$state" = healthy ]; then
      caps=$($CURL -fsS -m 5 "http://127.0.0.1:$PORT/api/v1/capabilities" 2>/dev/null || true)
      if [ -z "$want" ]; then
        [ -n "$caps" ] && return 0
      else
        case $caps in *"\"version\":\"$want\""*) return 0 ;; esac
      fi
    fi
    sleep "$POLL"
    waited=$((waited + POLL))
  done
  log "not ready after ${HEALTH_TIMEOUT}s (container state: ${state:-none})"
  [ -z "${cid:-}" ] || run $DOCKER logs --tail 25 "$cid" || true
  return 1
}

# Names of the checks `tincan doctor` reports as failed (one per line), or nothing. The doctor of the running app is asked
# with the public URL and TURN name of this installation; its own exit status is not used, only which checks fail.
doctor_failures() {
  url=$(env_value TINCAN_INSTANCE__PUBLIC_URL)
  turn=$(env_value TURN_DOMAIN)
  set --
  [ -z "$url" ] || set -- "$@" --url "$url"
  [ -z "$turn" ] || set -- "$@" --turn-domain "$turn"
  run compose exec -T tincan node dist/cli.js doctor "$@" >&2 || true # stdout is the list of failed checks
  sed -n 's/^\[!!\] *//p' "$RUN_OUT" | sed 's/  .*//; s/ *$//' | sort
}

# ---- 2. backup, and proof that it opens -----------------------------------------------------------------------------
old_image=$(running_image || true)
if [ -z "$old_image" ]; then
  old_image=$current_server
  log "the server is not running now; using $old_image for the backup"
fi
mkdir -p data/backups
if [ -f "$PASSPHRASE_FILE" ]; then
  log "backup (encrypted with $PASSPHRASE_FILE) ..."
else
  log "WARNING: $PASSPHRASE_FILE not found: the backup will not be encrypted"
fi
# shellcheck disable=SC2086  # pass is a list of flags on purpose
run $DOCKER run --rm -u "$uidgid" --env-file .env -e TINCAN_CONFIG=/config/config.yaml $pass \
  -v "$DIR/data:/data" -v "$DIR/config.yaml:/config/config.yaml:ro" \
  "$old_image" node dist/cli.js backup --out /data/backups || die 5 "the backup failed; nothing was changed"
archive=$(sed -n 's/^Backup written: //p' "$RUN_OUT" | head -n 1)
archive=$(basename "$archive")
[ -n "$archive" ] && [ -f "data/backups/$archive" ] || die 5 "the backup said nothing about its file, or the file is missing; nothing was changed"
backup_at=$(date +%s)
log "backup written: data/backups/$archive"

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/tincan-deploy-XXXXXX")
chmod 700 "$SCRATCH"
log "restoring it into a scratch directory to prove it opens ..."
# shellcheck disable=SC2086  # pass is a list of flags on purpose
run $DOCKER run --rm -u "$uidgid" $pass -v "$DIR/data/backups:/backups:ro" -v "$SCRATCH:/scratch" \
  "$old_image" node dist/cli.js restore "/backups/$archive" --into /scratch/restored \
  || die 5 "the backup does not restore; nothing was changed"
rm -rf "$SCRATCH"
SCRATCH=
log "the backup restores and verifies"

# What already fails now is not the new version's fault, e.g. a firewall port the probe cannot reach from here.
log "tincan doctor before the deploy (the baseline) ..."
baseline=$(doctor_failures)

# ---- 3. images ------------------------------------------------------------------------------------------------------
for ref in "$new_server" "$new_web"; do
  log "pulling $ref ..."
  run $DOCKER pull "$ref" || die 6 "cannot pull $ref; nothing was changed"
done

# ---- 4. compose file ------------------------------------------------------------------------------------------------
cp -p docker-compose.yml docker-compose.yml.pre-deploy
tmp=$(mktemp "$DIR/.docker-compose.XXXXXX")
if ! awk -v server="$new_server" -v web="$new_web" '
  skip && /^      / { next }
  { skip = 0 }
  /^    build:/ { skip = 1; next }
  /^    image:[ \t]+[^ \t]*tincan-server[^ \t]*[ \t]*$/ { print "    image: " server; s++; next }
  /^    image:[ \t]+[^ \t]*tincan-web[^ \t]*[ \t]*$/ { print "    image: " web; w++; next }
  { print }
  END { if (s < 1 || w < 1) exit 3 }
' docker-compose.yml >"$tmp"; then
  rm -f "$tmp"
  die 4 "could not set the image lines in docker-compose.yml; nothing was changed"
fi
cat "$tmp" >docker-compose.yml # keeps the file's owner and mode
rm -f "$tmp"
if ! compose config -q >/dev/null 2>&1; then
  cp -p docker-compose.yml.pre-deploy docker-compose.yml
  die 4 "the edited docker-compose.yml is not valid; the old file is back and nothing was changed"
fi
log "docker-compose.yml now points at $version (the old file is docker-compose.yml.pre-deploy)"

# ---- 5. start and check ---------------------------------------------------------------------------------------------
log "starting the new version ..."
ok=1
run compose up -d || ok=0
[ "$ok" = 0 ] || wait_ready "$version" || ok=0
if [ "$ok" = 1 ]; then
  log "tincan doctor after the deploy ..."
  after=$(doctor_failures)
  new=
  while IFS= read -r check; do
    [ -z "$check" ] || printf '%s\n' "$baseline" | grep -qxF -- "$check" || new="$new [$check]"
  done <<DOCTOR_EOF
$after
DOCTOR_EOF
  if [ -n "$new" ]; then
    log "doctor reports checks that passed before and fail now: $new"
    ok=0
  elif [ -n "$after" ]; then
    log "doctor still reports the checks that already failed before this deploy; not holding it against $version"
  fi
fi
if [ "$ok" = 1 ]; then
  log "== Deployed $version. Backup taken before: data/backups/$archive; previous compose file: docker-compose.yml.pre-deploy =="
  exit 0
fi

# ---- 6. rollback ----------------------------------------------------------------------------------------------------
log "== $version FAILED. Rolling back to $current_server =="
cp -p docker-compose.yml docker-compose.yml.failed-deploy
cp -p docker-compose.yml.pre-deploy docker-compose.yml
run compose up -d --remove-orphans || true
if wait_ready ""; then
  log "== Rolled back to the previous version; the database was not changed incompatibly, no data lost. =="
  exit 10
fi

log "the previous version does not start on this database (a migration changed it); putting the data back"
run compose stop tincan || true
stamp=$(date -u +%Y%m%dT%H%M%SZ)
snap=
for f in data/backups/pre-migrate-*.db; do
  [ -f "$f" ] && [ "$f" -nt data/backups/"$archive" ] && snap=$f # the name sorts by time, so the last one is the newest
done
if [ -n "$snap" ]; then
  log "restoring the pre-migration snapshot $snap"
  mv data/app.db "data/app.db.failed-$stamp" 2>/dev/null || true
  rm -f data/app.db-wal data/app.db-shm
  cp -p "$snap" data/app.db
  restored_at=$(date +%s)
  window_from=$(stat -c %Y "$snap" 2>/dev/null || echo "$backup_at")
else
  log "no pre-migration snapshot; restoring the backup data/backups/$archive"
  SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/tincan-deploy-XXXXXX")
  chmod 700 "$SCRATCH"
  # shellcheck disable=SC2086  # pass is a list of flags on purpose
  run $DOCKER run --rm -u "$uidgid" $pass -v "$DIR/data/backups:/backups:ro" -v "$SCRATCH:/scratch" \
    "$old_image" node dist/cli.js restore "/backups/$archive" --into /scratch/restored \
    && [ -f "$SCRATCH/restored/data/app.db" ] || die 12 "restoring the backup failed. The server is STOPPED. Data: $DIR/data, backup: data/backups/$archive. See $LOG"
  mv data/app.db "data/app.db.failed-$stamp" 2>/dev/null || true
  rm -f data/app.db-wal data/app.db-shm
  cp -p "$SCRATCH/restored/data/app.db" data/app.db
  restored_at=$(date +%s)
  window_from=$backup_at
fi
run compose up -d tincan || true
if ! wait_ready ""; then
  die 12 "the previous version does not start even on the restored database. The server needs a person: see $LOG. The failed database is data/app.db.failed-$stamp, the backup is data/backups/$archive"
fi
lost=$((restored_at - window_from))
log "== Rolled back AND restored the database from before the migration. =="
log "== Data written between $(date -u -d "@$window_from" +%H:%M:%SZ 2>/dev/null || echo "the snapshot") and now (about ${lost} s, at most) is gone. =="
log "== The database as the failed version left it is kept as data/app.db.failed-$stamp. =="
exit 11
