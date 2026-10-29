#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Two throwaway self-signed certificates for turn.example.test, to show that LiveKit reads the TURN certificate at start
# only (D6). Run inside any image that has openssl; writes ./certs/{a,b}.{crt,key}. Never commit the output.
set -eu
mkdir -p certs && cd certs
for n in a b; do
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$n.key" -out "$n.crt" -days 30 \
    -subj "/CN=turn.example.test-$n" -addext "subjectAltName=DNS:turn.example.test" 2>/dev/null
done
chmod 644 ./*.key
