#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Copies Tin Can backups from the server to THIS machine (a laptop, a NAS, a second server). Run it from the machine
# that should hold the copies, not on the server: the server then never holds a key to the place the copies live in,
# so whoever breaks into the server cannot reach the off-site copies.
#
#   sh pull-backups.sh mkarl.io:tincan/data/backups ~/tincan-backups
#
# The first argument is `ssh-host:path` (the ssh alias works, a relative path starts in the remote home directory).
# Archives that are already here are left alone and nothing is ever deleted here: the retention on the server
# (`--keep`) trims the server, you decide how long to keep your copies. Uses rsync when it exists, otherwise ssh + scp.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: sh pull-backups.sh <ssh-host>:<backup dir on the server> <local dir>" >&2
  exit 2
fi
remote=$1
dest=$2
host=${remote%%:*}
path=${remote#*:}
mkdir -p "$dest"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --ignore-existing --partial \
    --include='tincan-backup-*.tar.gz' --include='tincan-backup-*.tar.gz.enc' \
    --include='last-backup.json' --exclude='*' \
    "$remote/" "$dest/"
else
  # shellcheck disable=SC2029  # the path is meant to expand on this side
  names=$(ssh "$host" "ls -1 $path" | grep -E '^tincan-backup-.*\.tar\.gz(\.enc)?$' || true)
  for n in $names; do
    if [ ! -e "$dest/$n" ]; then
      scp -q "$host:$path/$n" "$dest/$n.part" && mv "$dest/$n.part" "$dest/$n"
      echo "copied $n"
    fi
  done
fi

count=$(ls -1 "$dest" | grep -cE '^tincan-backup-.*\.tar\.gz(\.enc)?$' || true)
newest=$(ls -1 "$dest" | grep -E '^tincan-backup-.*\.tar\.gz(\.enc)?$' | sort | tail -n 1 || true)
echo "$count backup(s) in $dest; newest: ${newest:-none}"
[ "$count" -gt 0 ] || { echo "no backups found: is the server making them? (tincan doctor shows the last one)" >&2; exit 1; }
