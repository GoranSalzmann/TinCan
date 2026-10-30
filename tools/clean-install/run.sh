#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Clean-install test (docs/18 §P): follows the README quickstart on a fresh Ubuntu machine, over plain HTTP on
# `localhost`, and checks that a newcomer ends with a working server: owner, login, a message, /readyz, doctor, and a
# backup that restores. Nothing here touches the Docker you run it with, except for building three images.
#
#   sh tools/clean-install/run.sh            (from the repository root; needs Docker, about 5 to 10 minutes)
#   KEEP=1 sh tools/clean-install/run.sh     leaves the machine running for a look: docker exec -it -u tester tincan-clean sh
#
# How: a privileged Ubuntu 24.04 container runs its own dockerd (Docker-in-Docker), so the install happens against a
# Docker that has never seen Tin Can, with an ordinary user in the docker group. The images are built here from the
# checkout and loaded into it, because released images do not exist for an unreleased commit; the README commands
# are run unchanged apart from the domain, the image name and leaving out voice (see inner.sh).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
export MSYS_NO_PATHCONV=1
cd "$root"

name=tincan-clean
volume=tincan-clean-docker
tag=0.0.0-clean
image=local/tincan

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
docker build -q -f deploy/Dockerfile --target server -t "$image-server:$tag" . >/dev/null
docker build -q -f deploy/Dockerfile --target web -t "$image-web:$tag" . >/dev/null
docker build -q -t tincan-clean-install tools/clean-install >/dev/null

echo "== Starting a fresh Ubuntu machine with its own Docker =="
docker run -d --name "$name" --privileged -v "$volume:/var/lib/docker" tincan-clean-install >/dev/null
i=0
until docker exec "$name" docker info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "The Docker daemon inside the test machine did not start. Its log:" >&2
    docker exec "$name" tail -n 30 /var/log/dockerd.log >&2 || true
    exit 1
  fi
  sleep 1
done

echo "== Loading the images into it =="
docker save "$image-server:$tag" "$image-web:$tag" | docker exec -i "$name" docker load

docker cp tools/clean-install/inner.sh "$name:/home/tester/inner.sh"
docker cp README.md "$name:/home/tester/README.md"
docker cp deploy/backup/restore-drill.sh "$name:/home/tester/restore-drill.sh"
docker exec "$name" chown tester /home/tester/inner.sh /home/tester/README.md /home/tester/restore-drill.sh

echo "== Running the install as an ordinary user =="
docker exec -u tester -w /home/tester -e "IMAGE=$image" -e "TAG=$tag" "$name" sh /home/tester/inner.sh
