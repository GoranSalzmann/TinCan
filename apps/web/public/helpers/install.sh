#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu

base=${1:?Usage: sh install.sh https://your-tincan-server/helpers}
base=${base%/}
case "$base" in
    https://* | http://localhost:* | http://127.0.0.1:*) ;;
    *) echo "Use your Tin Can server's HTTPS helper download URL." >&2; exit 1 ;;
esac
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
    echo "This download is for Linux x86-64." >&2
    exit 1
fi
for cmd in curl tar sha256sum pw-dump pw-loopback pw-link; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing $cmd. Install curl and your distribution's PipeWire tools first." >&2
        echo "Debian/Ubuntu: pipewire-bin  |  Fedora: pipewire-utils  |  Arch: pipewire  |  openSUSE: pipewire-tools" >&2
        echo "PipeWire, its PulseAudio compatibility service, and a session manager must be running." >&2
        exit 1
    fi
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
archive=tincan-audio-linux-amd64.tar.gz
echo "Downloading Tin Can Audio…"
curl --fail --silent --show-error --location "$base/$archive" -o "$tmp/$archive"
curl --fail --silent --show-error --location "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
# Check precisely this archive; never follow additional manifest paths.
checksum=$(awk '$2 == "tincan-audio-linux-amd64.tar.gz" && length($1) == 64 { print $1 }' "$tmp/SHA256SUMS")
if [ "${#checksum}" != 64 ]; then
    echo "Invalid download checksum. Please try again." >&2
    exit 1
fi
(cd "$tmp" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -)
tar -xzf "$tmp/$archive" -C "$tmp"
"$tmp/tincan-audio/tincan-audio" doctor
"$tmp/tincan-audio/tincan-audio" install
