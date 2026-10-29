# M3 voice spikes (D1, D2, D4, D6)

Throwaway code and raw output behind the M3 decisions. Results and what they changed are in `docs/18-open-questions-and-risks.md`
§D and §J. Everything ran in Docker on Docker Desktop (Windows, WSL2); Chromium is the one in
`mcr.microsoft.com/playwright:v1.60.0-noble`, LiveKit is `livekit/livekit-server:v1.13.10`.

| Folder / file | Spike | What it does |
|---|---|---|
| `probe/d1-api.mjs` | D1 | room creation and SID, webhooks, token refresh, `updateParticipant`, removal, SID after `empty_timeout` (raw signalling client, no media) |
| `probe/d1-load.mjs` | D1 | 1080p simulcast publisher, 0 → 5 viewers, publisher `outbound-rtp` per layer; `MODE=low` uses adaptive stream with small tiles |
| `probe/d4-e2ee.mjs` | D4 | E2EE + simulcast + dynacast, active speakers, late joiner, wrong key, key change |
| `probe/d6-relay.mjs` | D6 | which transport a browser ends up on (normal, UDP blocked by iptables, relay-only) |
| `d6/` | D6 | LiveKit config with TURN/TLS and `bind_addresses`; `make-certs.sh` makes throwaway certificates |
| `probe/d2-denoise.mjs` | D2 | CPU of the denoiser worklets (did not produce usable numbers, see `results-d2-package-survey.txt`) |
| `probe/browser-lib.mjs` | | shared harness: fake-device Chromium, a page with `livekit-client`, `getStats()` rates |
| `results-*.txt` | | raw output of the runs quoted in 18 §J |

## Run

The browser container shares LiveKit's network namespace, so `127.0.0.1` works for ICE:

```sh
docker network create m3
docker volume create m3-probe-nm
docker run --rm -v "$PWD/probe:/p" -v m3-probe-nm:/p/node_modules -w /p node:24-bookworm \
  npm install livekit-server-sdk @livekit/protocol ws livekit-client@2.23.0 playwright-core@1.60.0 @sapphi-red/web-noise-suppressor@0.4.1
docker run -d --name lk --network m3 -v "$PWD/livekit/livekit.yaml:/etc/livekit.yaml:ro" livekit/livekit-server:v1.13.10 --config /etc/livekit.yaml
docker run --rm --network container:lk --ipc=host -v "$PWD/probe:/p" -v m3-probe-nm:/p/node_modules -w /p \
  mcr.microsoft.com/playwright:v1.60.0-noble node d1-load.mjs
```

## Against the real server (VPS runbook, docs/qa/m3.md)

`d1-load.mjs` and `d4-e2ee.mjs` read `LK_URL` (public `wss://…/livekit`), `LK_KEY` and `LK_SECRET` (from the server's `.env`)
and `LK_API` (for the Twirp client; use the loopback URL through an SSH tunnel). Run them from a machine that is not the
server, so the numbers include the real network path; watch `docker stats` on the server for CPU.
