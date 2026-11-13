#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run from the repository root, after cargo build --release for x86_64 musl.
set -eu
binary=${1:?Usage: package-audio-helper.sh BINARY OUTPUT_DIRECTORY}
out=${2:?Missing output directory}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$out" "$stage/tincan-audio"
cp "$binary" "$stage/tincan-audio/tincan-audio"
chmod 755 "$stage/tincan-audio/tincan-audio"
cp LICENSE "$stage/tincan-audio/LICENSE"
cp apps/audio-helper/README.md "$stage/tincan-audio/README.md"
# Preserve dependency copyright and licence texts alongside the static binary.
registry=${CARGO_HOME:-"$HOME/.cargo"}/registry/src
if [ -d "$registry" ]; then
    mkdir "$stage/tincan-audio/third-party-licenses"
    find "$registry" -mindepth 2 -maxdepth 2 -type d | while IFS= read -r crate; do
        name=$(basename "$crate")
        mkdir -p "$stage/tincan-audio/third-party-licenses/$name"
        find "$crate" -maxdepth 1 -type f \( -iname '*license*' -o -iname '*licence*' -o -iname '*copyright*' -o -iname '*notice*' \) \
            -exec cp '{}' "$stage/tincan-audio/third-party-licenses/$name/" \;
    done
fi
tar -czf "$out/tincan-audio-linux-amd64.tar.gz" -C "$stage" tincan-audio
if ! cmp -s apps/web/public/helpers/install.sh "$out/install.sh"; then
    cp apps/web/public/helpers/install.sh "$out/install.sh"
fi
(cd "$out" && sha256sum tincan-audio-linux-amd64.tar.gz > SHA256SUMS)
