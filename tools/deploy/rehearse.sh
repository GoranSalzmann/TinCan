#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Deploy rehearsal (docs/guides/deploy.md §7): deploy/deploy.sh against real Docker on a scratch machine, never on a real
# server. A privileged Ubuntu container runs its own dockerd (like tools/clean-install) and a local registry; it plays
# the part of mkarl.io:
#   1. an installation that builds from source (compose with `build:` blocks, locally built images, encrypted backup);
#   2. the first deploy of a release image onto it (the one-time migration), through the real forced-command entry;
#   3. a deploy of a release that never becomes healthy: it must roll back and keep the data;
#   4. a deploy of a release that does not exist: nothing may change;
#   5. a second deploy of the good release (the normal case afterwards).
#
#   sh tools/deploy/rehearse.sh      (from the repository root; needs Docker, about 5 to 10 minutes)
#   KEEP=1 sh tools/deploy/rehearse.sh   leaves the machine running: docker exec -it -u tester -w /home/tester tincan-deploy sh
#
# What it cannot show: a migration that the old version cannot read (the fake-docker tests and tools/upgrade-rehearsal
# cover that), the real GHCR, and ssh itself (the forced command is simulated by setting SSH_ORIGINAL_COMMAND).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
export MSYS_NO_PATHCONV=1
cd "$root"

name=tincan-deploy
volume=tincan-deploy-docker

cleanup() {
  if [ -z "${KEEP:-}" ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
  else
    echo "Left running: $name  (docker exec -it -u tester -w /home/tester $name sh)"
  fi
}
trap cleanup EXIT INT TERM
docker rm -f "$name" >/dev/null 2>&1 || true
docker volume rm "$volume" >/dev/null 2>&1 || true

echo "== Building the images from this checkout =="
docker build -q -f deploy/Dockerfile --target server -t tincan-server . >/dev/null
docker build -q -f deploy/Dockerfile --target web -t tincan-web . >/dev/null
# A "release" that starts and then dies, to rehearse the rollback.
printf 'FROM tincan-server\nCMD ["node","-e","process.exit(1)"]\n' | docker build -q -t tincan-server:broken - >/dev/null
docker build -q -t tincan-clean-install tools/clean-install >/dev/null

echo "== Starting a fresh Ubuntu machine with its own Docker =="
docker run -d --name "$name" --privileged -v "$volume:/var/lib/docker" tincan-clean-install >/dev/null
i=0
until docker exec "$name" docker info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "The Docker daemon inside the test machine did not start." >&2
    exit 1
  fi
  sleep 1
done

echo "== Loading the images into it =="
docker save tincan-server tincan-web tincan-server:broken | docker exec -i "$name" docker load
docker cp deploy/deploy.sh "$name:/home/tester/deploy.sh"
docker cp tools/deploy/rehearse-inner.sh "$name:/home/tester/rehearse-inner.sh"
docker exec "$name" chown tester /home/tester/deploy.sh /home/tester/rehearse-inner.sh

echo "== Running the rehearsal as an ordinary user =="
docker exec -u tester -w /home/tester "$name" sh /home/tester/rehearse-inner.sh
