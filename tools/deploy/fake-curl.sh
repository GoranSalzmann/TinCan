#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# A stand-in for `curl` for deploy.test.ts: answers /api/v1/capabilities with the version the fake docker runs.
v=$(cat "$FAKE_STATE/running" 2>/dev/null || echo none)
printf '{"server":{"version":"%s"}}\n' "$v"
