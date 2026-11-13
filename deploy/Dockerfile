# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Three targets (14 §2):
#   server  the app: REST API, WebSocket gateway, admin CLI (`node dist/cli.js`)
#   web     Caddy with the built web client in /srv/web
# Build from the repository root:
#   docker build -f deploy/Dockerfile --target server -t tincan-server .
#   docker build -f deploy/Dockerfile --target web    -t tincan-web .

ARG NODE_VERSION=24

# The companion download is x86-64 on both server architectures.
FROM --platform=linux/amd64 rust:1.100-alpine AS audio-helper-build
WORKDIR /repo
COPY apps/audio-helper apps/audio-helper
COPY scripts/package-audio-helper.sh scripts/package-audio-helper.sh
COPY apps/web/public/helpers/install.sh apps/web/public/helpers/install.sh
COPY LICENSE LICENSE
RUN cargo build --locked --release --manifest-path apps/audio-helper/Cargo.toml \
 && sh scripts/package-audio-helper.sh apps/audio-helper/target/release/tincan-audio /out/helpers

FROM node:${NODE_VERSION}-bookworm-slim AS build
# Only needed if a native dependency has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.16.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build
# A self-contained copy of the server with production dependencies only.
RUN pnpm --filter @tincan/server deploy --prod /out/server

FROM node:${NODE_VERSION}-bookworm-slim AS server
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/server /app
COPY LICENSE /app/LICENSE
# Runs as a non-root user; /data is the only writable path (14 §2). `docker compose` passes the host user's uid:gid.
USER node
EXPOSE 3000
CMD ["node", "dist/cli.js", "serve"]

FROM caddy:2 AS web
COPY --from=build /repo/apps/web/dist /srv/web
COPY --from=audio-helper-build /out/helpers /srv/web/helpers
COPY LICENSE /srv/web/LICENSE.txt
