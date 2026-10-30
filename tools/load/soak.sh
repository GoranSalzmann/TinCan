#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# The soak scenario in a container with a memory ceiling, so an out-of-memory kill or a creeping RSS shows up the way it
# would on a small VPS (16 §8). Nothing leaves the container; it talks only to its own temporary server.
#   sh tools/load/soak.sh            (from the repository root; SOAK_MINUTES=30 SOAK_MEM=512m SOAK_SOCKETS=300 to change)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
export MSYS_NO_PATHCONV=1
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf %s "$1"; fi; }
docker volume create tincan-load-work >/dev/null
docker run --rm --memory "${SOAK_MEM:-768m}" --cpus "${SOAK_CPUS:-2}" \
  -v "$(win "$root"):/src:ro" -v tincan-load-work:/work -w /work \
  node:24-bookworm sh -c "
    set -e
    npm i -g pnpm@12.16.1 >/dev/null 2>&1
    tar -C /src --exclude=node_modules --exclude=.git --exclude=dist --exclude=dist-types --exclude='*.tsbuildinfo' -cf - . | tar -C /work -xf -
    pnpm install --frozen-lockfile >/dev/null
    pnpm load --scenario soak --minutes ${SOAK_MINUTES:-10} --sockets ${SOAK_SOCKETS:-300}
  "
