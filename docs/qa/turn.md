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
| _none yet_ | | | | |

## Not tested

- Firefox and Safari behaviour through TURN.
- A real UDP-blocking firewall (the `relay-tls` mode restricts the ICE configuration; it does not block UDP on the network).
- TURN on 443 (an optional advanced setup, not part of this change).
- Certificate renewal followed by `tincan voice turn-reload` on the real host.
