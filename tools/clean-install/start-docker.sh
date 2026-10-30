#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Starts the Docker daemon of the throw-away machine and keeps the container alive.
set -eu
exec dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 > /var/log/dockerd.log 2>&1
