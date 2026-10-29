#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs the media test where host networking is not available (Docker Desktop on Windows or macOS): LiveKit in one
# container, and the app, the web client and Chromium in a second one that shares its network namespace.
#   sh tools/media-test/docker.sh        (from the repository root)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
LK_IMAGE=$(sed -n 's/.*LIVEKIT_IMAGE = "\(.*\)";/\1/p' "$root/apps/server/src/cli/templates.ts")
export MSYS_NO_PATHCONV=1
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf %s "$1"; fi; }

docker rm -f tincan-media-lk >/dev/null 2>&1 || true
docker run -d --name tincan-media-lk -v "$(win "$here")/livekit.yaml:/etc/livekit.yaml:ro" "$LK_IMAGE" --config /etc/livekit.yaml >/dev/null
trap 'docker rm -f tincan-media-lk >/dev/null 2>&1 || true' EXIT

docker volume create tincan-media-work >/dev/null
docker run --rm --network container:tincan-media-lk --ipc=host \
  -e MEDIA_LK=external -e CI=1 ${MEDIA_SHOTS:+-e MEDIA_SHOTS=/shots -v "$MEDIA_SHOTS:/shots"} \
  -v "$(win "$root"):/src:ro" -v tincan-media-work:/work -w /work \
  mcr.microsoft.com/playwright:v1.60.0-noble sh -c '
    set -e
    npm i -g pnpm@12.16.1 >/dev/null 2>&1
    tar -C /src --exclude=node_modules --exclude=.git --exclude=dist --exclude=dist-types --exclude="*.tsbuildinfo" -cf - . | tar -C /work -xf -
    pnpm install --frozen-lockfile >/dev/null
    pnpm --filter @tincan/web build >/dev/null
    pnpm media-test
  '
