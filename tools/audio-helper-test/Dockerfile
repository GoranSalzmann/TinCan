# SPDX-License-Identifier: AGPL-3.0-or-later
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    dbus-daemon pipewire pipewire-bin pipewire-pulse wireplumber python3 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENTRYPOINT ["dbus-run-session", "--", "python3", "tools/audio-helper-test/run.py"]
