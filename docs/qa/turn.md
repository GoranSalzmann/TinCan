# TURN relay: test record

How to run the checks is in the [TURN guide](../guides/turn.md). This file records what was run, where, and what is not covered.

## What the automated tests cover (CI)

- The STUN/TURN probe used by `doctor` and `turn-test` (request encoding, 401 detection, silence, wrong transaction id): `apps/server/src/cli/turn-probe.test.ts`.
- The generated `livekit.yaml` / `Caddyfile` / compose volume for `--turn-domain`, and the snippets printed for an existing installation: `templates.test.ts`.
- The test-token (10 minutes, listen-only, throwaway room): `doctor.test.ts`.

## What cannot run in CI

`pnpm turn-test` needs a LiveKit with TURN, a certificate for its name and open ports, so it runs by hand against a real host. Spike D6-4 showed that a Docker bridge network where the TURN server and the SFU share one address does **not** prove or disprove relaying (the SFU's checks to the relay candidate got no answer there). A Linux CI job with `iptables` in a network namespace is the way to automate "UDP blocked"; not built.

## Runs

| Date | Host | From | Mode | Result |
|---|---|---|---|---|
| 2026-10-30 | mkarl.io (LiveKit v1.13.10, turn.mkarl.io, certificate from Caddy) | Windows PC on a home connection, headless Edge | `direct` | ok, srflx/udp via stun:3478, rtt 51 ms |
| 2026-10-30 | same | same | `relay` | ok, relay/udp via turn:3478, rtt 53 ms |
| 2026-10-30 | same | same | `relay-udp` | ok, relay/udp, rtt 51 ms |
| 2026-10-30 | same | same | `relay-tls` as advertised (turns:…:443) | **fails**: could not establish pc connection (443 is Caddy) |
| 2026-10-30 | same | same | `relay-tls` with `TURN_TLS_PORT=5349` | ok, relay/tls via turns:turn.mkarl.io:5349, rtt 51 ms |
| 2026-10-30 | same | PC, probe from outside | Allocate probe 3478/udp and 5349/tls | both answered 401 (realm livekit) |
| 2026-10-30 | same | on the server | `tincan doctor` | all required checks ok, TLS certificate 89 days; also run with the pre-change image, so the new UDP check was not exercised there |

Deployment on mkarl.io: `TURN_DOMAIN` in `.env`, a Caddy site for the name (certificate obtained on the first start), the `turn:` block in `livekit.yaml`, and the LiveKit API secret rotated at the same time (new value generated on the host, in `livekit.yaml` and `.env` only; `tincan` and `livekit` restarted, webhooks and the API accepted the new secret). Rollback was not needed; the files before the change are in a 0700 backup directory on the host.

## Not tested

- Firefox and Safari behaviour through TURN.
- A real UDP-blocking firewall (the `relay-tls` mode restricts the ICE configuration; it does not block UDP on the network).
- A normal voice join through the web client after the secret rotation (no test account was available to the session); the API and webhook path were checked by `tincan doctor` and the webhook log instead.
- TURN on 443: **needed**, see [the guide §6](../guides/turn.md); LiveKit advertises 443.
- Certificate renewal followed by `tincan voice turn-reload` on the real host.
