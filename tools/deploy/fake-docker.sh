#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# A stand-in for `docker` for deploy.test.ts: just enough state to run deploy.sh end to end. It keeps its state in
# $FAKE_STATE and reads the scenario from FAKE_* variables. Never used outside the tests.
set -u
st=$FAKE_STATE
echo "docker $*" >>"$st/calls"
server_image() { sed -n 's/^    image:[[:space:]]*\([^[:space:]]*tincan-server[^[:space:]]*\)[[:space:]]*$/\1/p' docker-compose.yml | head -n 1; }
version_of() { case $1 in *:*) echo "${1##*:}" ;; *) echo local ;; esac; }
healthy() {
  running=$(cat "$st/running" 2>/dev/null || echo none)
  case " ${FAKE_BAD:-} " in *" $running "*) return 1 ;; esac
  # an old version refuses to start on a migrated database
  if [ -f "$st/migrated" ] && [ "$running" = "${FAKE_OLD:-1.0.0}" ]; then return 1; fi
  return 0
}
case ${1:-} in
  info) exit 0 ;;
  pull)
    [ -z "${FAKE_FAIL_PULL:-}" ] || { echo "manifest unknown" >&2; exit 1; }
    echo "pulled $2"
    ;;
  inspect)
    case $* in
      *Config.Image*) cat "$st/running_image" ;;
      *Health.Status*) if healthy; then echo healthy; else echo unhealthy; fi ;;
    esac
    ;;
  logs) echo "fake server log: refusing to start" ;;
  run)
    case $* in
      *" backup "*|*"cli.js backup"*)
        [ -z "${FAKE_FAIL_BACKUP:-}" ] || { echo "backup exploded" >&2; exit 1; }
        n=tincan-backup-$(date +%s%N 2>/dev/null || date +%s).tar.gz
        echo data >"data/backups/$n"
        echo "Backup written: /data/backups/$n" ;;
      *"cli.js restore"*)
        [ -z "${FAKE_FAIL_RESTORE:-}" ] || { echo "checksum mismatch" >&2; exit 1; }
        scratch=$(echo "$*" | sed -n 's/.*-v \([^ ]*\):\/scratch.*/\1/p')
        mkdir -p "$scratch/restored/data"
        echo "backup copy" >"$scratch/restored/data/app.db"
        echo "Restored 3 file(s)" ;;
    esac
    ;;
  compose)
    shift
    while [ "${1:-}" = --profile ]; do shift 2; done
    case ${1:-} in
      config) exit "${FAKE_CONFIG_RC:-0}" ;;
      ps) [ -f "$st/running" ] && echo fakecid ;;
      stop) rm -f "$st/running" ;;
      up)
        img=$(server_image)
        v=$(version_of "$img")
        echo "$v" >"$st/running"
        echo "$img" >"$st/running_image"
        case " ${FAKE_MIGRATES:-} " in
          *" $v "*)
            sleep 1
            echo migrated >data/app.db
            [ -n "${FAKE_NO_SNAPSHOT:-}" ] || echo "snapshot before migration" >"data/backups/pre-migrate-$(date +%s).db"
            touch "$st/migrated" ;;
        esac
        # a restore puts back an old database: the old version can start again
        if [ "$(cat data/app.db 2>/dev/null)" != migrated ]; then rm -f "$st/migrated"; fi
        ;;
      exec)
        # FAKE_DOCTOR_FAIL lists the versions whose doctor reports a failed check
        case " ${FAKE_DOCTOR_FAIL:-} " in
          *" $(cat "$st/running") "*) echo "[!!]  Disk space                              0 GiB free"; echo "1 check(s) failed."; exit 1 ;;
        esac
        echo "[ok]  Configuration"; echo "All required checks passed." ;;
    esac
    ;;
esac
exit 0
