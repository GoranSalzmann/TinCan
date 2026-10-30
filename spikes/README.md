# Spikes (throwaway)

This directory is a record of experiments, not maintained code: its lockfile is not updated by Dependabot and it is excluded from the header, secret and licence checks.

Spike code for milestone M0 (17 §3). Not product code: nothing here is imported
by the product, and it can be deleted once the decisions it informs are made.
Results and recommendations live in the docs (03 ADR-005/ADR-007, 05 §3.1,
18 §D); the raw output of the runs is in each spike's `RESULTS.md`.

| Folder | Question | Doc |
|---|---|---|
| `d5-db/` | D5: Kysely vs Drizzle on better-sqlite3 + FTS5; async transactions; outbox → FTS5; main-thread blocking on a ~4 GB DB (T2, T28, T29) | 03 ADR-007, 05 §3.1, 18 |
| `t1-http/` | T1: Fastify vs Hono for REST (zod, OpenAPI) and the WebSocket gateway | 03 ADR-005, 18 |

## Running

Both spikes ran in Docker (`node:24-bookworm`, Node 24.22) on a Ryzen 7 5800X
(Docker Desktop on WSL2, ext4 volume). Blocking numbers used `--memory=2g --cpus=2`
so the 4 GB database cannot sit in page cache, and `--privileged` only to drop the
page cache between cold runs. To repeat on the target VPS, run the same commands
with Node 24 directly:

```sh
cd spikes/d5-db && npm ci
npm run tx                                  # transaction serialisation scenarios
npx tsx src/migrate/run.ts                  # Kysely module migrations
sh src/migrate/drizzle-demo.sh              # drizzle-kit workflow for comparison
npm run outbox                              # outbox -> FTS5 crash and reindex tests
npm run overhead                            # per-query cost of each access path
npx tsx src/fixture/generate.ts /data/fixture/app.db 4      # ~4 GB fixture (~100 s)
npx tsx src/bench/blocking.ts /data/fixture/app.db fts unindexed backup backupwrites vacuuminto optimize worker copy retention ftsmerge drain reindex
npx tsx src/bench/followup.ts rankfix chanfts bgsnap
npx tsc --noEmit                            # typed-query checks (@ts-expect-error lines)

cd ../t1-http && npm ci
npm run check                               # feature matrix
npm run bench                               # HTTP and gateway fan-out numbers
```

## M3 spikes

`m3-voice/` holds D1 (LiveKit behaviour and load), D2 (denoiser candidates), D4 (E2EE with simulcast) and D6 (network and
TURN). See its own README; results are in `docs/18-open-questions-and-risks.md` §D and §J.
