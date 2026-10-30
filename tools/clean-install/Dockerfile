# SPDX-License-Identifier: AGPL-3.0-or-later
# A fresh Ubuntu machine with Docker and nothing else Tin Can needs: the "newcomer's server" of tools/clean-install/run.sh.
# It runs its own Docker daemon (the container is started with --privileged), so the install happens inside it and
# cannot touch the Docker of the machine running the test.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io docker-compose-v2 ca-certificates curl jq sqlite3 iproute2 iptables \
 && rm -rf /var/lib/apt/lists/*
# An ordinary user in the docker group, like the account of someone who just installed Docker on a VPS.
RUN userdel -r ubuntu 2>/dev/null; useradd --create-home --uid 1000 --shell /bin/sh --groups docker tester
COPY start-docker.sh /usr/local/bin/start-docker.sh
CMD ["/usr/local/bin/start-docker.sh"]
