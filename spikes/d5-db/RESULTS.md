# Spike D5 results (2026-10-28)

Raw output of the runs behind 03 ADR-007, 05 §3.1 and 18 §D D5. Commands are in
`../README.md`.

**Setup.** Node 24.22.1, better-sqlite3 13.0.3 (SQLite 3.53.4, FTS5 on),
Kysely 0.29.7, drizzle-orm 0.45.4 (and 1.0.0-rc.5 where noted), TypeScript 7.0.2.
Docker `node:24-bookworm` on a Ryzen 7 5800X, Docker Desktop/WSL2, ext4 volume on
NVMe. Blocking numbers: `--memory=2g --cpus=2`; "cold" = page cache dropped first.
A cheap VPS (shared vCPU, network disk) will be slower; rerun
`src/bench/blocking.ts` there before quoting absolute numbers.

**Fixture.** 3,380,000 messages over one year, 30 channels (busiest 518k, quietest
5k), 100 authors, Zipf vocabulary, average 278 chars. 4.00 GB, built in 98 s:

| Object | Size |
|---|---|
| message | 1.40 GB |
| message_fts_content (FTS5's copy of the text) | 1.26 GB |
| message_fts_data (the index) | 447 MB |
| message_author, message_channel indexes | 232 MB each |
| message PK, search_doc + its unique index | 136 + 121 + 136 MB |

## 1. Async `transaction(fn)` on one better-sqlite3 connection

`npm run tx`. Scenarios: *interleave* (another request's write while a tx awaits),
*rollbackIsolation* (tx fails; the other request's write must survive),
*dirtyRead* (read during an open tx must not see its rows), *stress* (300 concurrent
requests, tx of 1–4 writes with awaits, 25% fail), *outerHandleInsideTx* (callback
uses the root handle by mistake), *headOfLineBlocking* (reads queued behind a tx
that awaits 50 ms of non-DB work).

```
## naive BEGIN/await/COMMIT (control, no mutex)
  FAIL  interleave           ["T-begin","R","T-end"]
  FAIL  rollbackIsolation    []
  FAIL  dirtyRead            seen during tx=1, after rollback=0
  FAIL  stress               violations=136, unexpected errors=198 (cannot start a transaction within a transaction)
  PASS  outerHandleInsideTx  B ran inside the transaction and was rolled back: []
  PASS  headOfLineBlocking   50 concurrent reads during a tx awaiting 50 ms: min 0.1 ms, max 0.9 ms

## kysely (SqliteDialect, begin immediate)
  PASS  interleave           ["T-begin","T-end","R"]
  PASS  rollbackIsolation    ["R"]
  PASS  dirtyRead            seen during tx=0, after rollback=0
  PASS  stress               violations=0, unexpected errors=0
  FAIL  outerHandleInsideTx  DEADLOCK: transaction never finishes; every later query on this Db would hang
  PASS  headOfLineBlocking   50 concurrent reads during a tx awaiting 50 ms: min 48.8 ms, max 49.3 ms

## kysely + AsyncLocalStorage guard on the root handle
  PASS  interleave           ["T-begin","T-end","R"]
  PASS  rollbackIsolation    ["R"]
  PASS  dirtyRead            seen during tx=0, after rollback=0
  PASS  stress               violations=0, unexpected errors=0
  PASS  outerHandleInsideTx  rejected with: Db: used the root handle (.insertInto) inside a transaction; use the tx handle; nothing written
  PASS  headOfLineBlocking   50 concurrent reads during a tx awaiting 50 ms: min 49.9 ms, max 51.1 ms

## drizzle better-sqlite3 (stock db.transaction with an async callback)
  FAIL  interleave           ["T-begin","R"] errors: Transaction function cannot return a promise
  FAIL  rollbackIsolation    ["T-a","R"]
  FAIL  dirtyRead            seen during tx=1, after rollback=1
  FAIL  stress               violations=174, unexpected errors=200 (Transaction function cannot return a promise)
  FAIL  outerHandleInsideTx  not atomic: rows survived the rollback ["A","B"]
  FAIL  headOfLineBlocking   threw: Transaction function cannot return a promise

## drizzle sqlite-proxy + mutex + AsyncLocalStorage owner
  PASS  interleave           ["T-begin","T-end","R"]
  PASS  rollbackIsolation    ["R"]
  PASS  dirtyRead            seen during tx=0, after rollback=0
  PASS  stress               violations=0, unexpected errors=0
  PASS  outerHandleInsideTx  B ran inside the transaction and was rolled back: []
  PASS  headOfLineBlocking   50 concurrent reads during a tx awaiting 50 ms: min 49.5 ms, max 50.7 ms
```

- Kysely 0.29 moved the connection mutex from `SqliteDriver` into `RuntimeDriver`
  (on for any adapter with `supportsMultipleConnections === false`); 0.28 had it in
  the driver. Either way every query waits for the single connection, and a
  transaction holds it from `begin` to `commit`.
- Kysely's `SqliteDriver` sends a deferred `begin`; the spike overrides
  `beginTransaction` to send `begin immediate` (`src/common/kysely.ts`).
- Drizzle's better-sqlite3 transactions are synchronous only (confirmed). In 0.45.4
  an async callback type-checks, then throws *Transaction function cannot return a
  promise* after rolling back the part before the first `await`; the rest runs in
  autocommit. In **1.0.0-rc.5 it fails silently**: the transaction commits before the
  first `await`, the caller still receives the callback's error, and every row
  persists:
  ```
  drizzle-orm 1.0.0-rc.5
  error seen by caller: boom
  rows after the callback threw: ["before-await","after-await"]
  ```
- Drizzle can serialise correctly through its async `sqlite-proxy` driver plus a
  mutex and AsyncLocalStorage (`src/tx/impls.ts`), at the per-query cost in §4.

## 2. Typed queries and migrations without codegen

`npx tsc --noEmit` passes, so every `@ts-expect-error` in `src/typed/` is a real
error. Both builders catch: unknown column, wrong value type, missing required
column, comparing text with a number, reading a column that was not selected.

- **FTS5.** Kysely: declare `message_fts` as a table type; `MATCH` and `bm25()` are
  `sql<T>` fragments inside an otherwise typed query. Drizzle: `sqlite-core` cannot
  declare virtual tables, so the whole statement is `sql` with an unchecked row type.
- **Module boundaries.** `Kysely<DB>` is assignable to `Kysely<SearchTables>` without
  a cast, and the narrowed handle rejects other modules' tables at compile time.
- **Kysely migrations** (`npx tsx src/migrate/run.ts`): plain TS objects per module,
  own ~40-line runner, `_migrations(module, version, name, applied_at)`:
  ```
  1. fresh database          applied core v1, text-chat v1, search v1 (FTS5 via sql``)
  2. same server restarts    (nothing pending)
  3. upgrade ships v2        applied text-chat v2 message.pinned_at
  4. older binary            refused: schema of module 'text-chat' is v2 but this server knows v1
  5. failing migration       half_done table exists afterwards: false; core version recorded: 1
  ```
- **Drizzle migrations** (`sh src/migrate/drizzle-demo.sh`): `drizzle-kit generate`
  (0.74 s) writes SQL plus a snapshot JSON for every schema change; FTS5 needs
  `generate --custom` and hand-written SQL (the stub ends without a newline, so
  naive appends break it); per-module tracking works through `migrationsTable`.
  The TS schema is the single source for types and DDL, which Kysely's hand-written
  types are not.

## 3. Outbox → FTS5 (`npm run outbox`)

```
1. SIGKILL after 600 committed writes (500 create, 50 edit, 50 delete), before any drain
  after restart, before drain:       {ok:false,live:450,docs:0,fts:0,missing:450,stale:0,orphans:0,ftsNoDoc:0,outbox:600}
  drained 600 rows in 231 ms:        {ok:true,live:450,docs:450,fts:450,missing:0,stale:0,orphans:0,ftsNoDoc:0,outbox:0}
  token search:                      {checked:500,bad:0}
2. SIGKILL after a handler committed but before its outbox row was deleted (redelivery)
  after restart, before drain:       {ok:false,live:200,docs:101,fts:101,missing:99,stale:0,orphans:0,ftsNoDoc:0,outbox:100}
  after drain:                       {ok:true,live:200,docs:200,fts:200,missing:0,stale:0,orphans:0,ftsNoDoc:0,outbox:0}
3. 8 rounds of SIGKILL at a random moment while writes and drain run concurrently
  round 2: killed after 933 ms; backlog 2686, unindexed 1244, stale 24 -> after drain ok=true (live 1278)
  round 6: killed after 1022 ms; backlog 3050, unindexed 1709, stale 498 -> after drain ok=true (live 4244)
  (all 8 rounds ok=true)             final token search: {checked:6450,bad:0}
4. damage the index, then `search reindex` while writes and drain keep running
  damaged:                           {ok:false,live:3000,docs:3001,fts:2701,missing:0,stale:159,orphans:1,ftsNoDoc:0,outbox:0}
  reindex {cleared:3000,indexed:3008} in 374 ms: {ok:true,live:3007,docs:3007,fts:3007,missing:0,stale:0,orphans:0,ftsNoDoc:0,outbox:0}
```

- `search_doc(fts_rowid, message_id UNIQUE)` is needed: 06 §3.9 keys FTS rows by an
  UNINDEXED `message_id`, and FTS5 cannot look that column up. On the fixture:
  lookup by UNINDEXED `message_id` **494–511 ms** (cold) per edit/delete; via
  `search_doc` 0.8–0.9 ms; by rowid 0.2 ms.
- On the 4 GB DB: `createMessage` (message + outbox row in one tx) 3,918 tx/s; drain
  2,809 rows/s with one tx per row; a 200-row drain batch blocked 170 ms.
- Reindex on the 4 GB DB (`blocking.ts reindex`, batch 500, capped at 60 s/phase):
  clear 15,986 rows/s (3.5 min projected), re-index 9,412 msgs/s (5.8 min) → about
  **9.3 min** for 3.38M messages, max block 138 / 243 ms per batch.
- First version cleared with `DELETE … WHERE rowid > ? AND rowid <= ?`: 49 rows/s,
  9.7 s per batch. FTS5 accepts the range in its plan (`INDEX 0:><`) yet a
  100-rowid range delete took 9,344 ms, while point deletes run 8,759–33,004 rows/s.
  The fixed version drives `rowid = ?` deletes from b-tree ranges.

## 4. Per-query cost (`npm run overhead`, 100k rows, µs per awaited call)

| Path | PK select | page of 50 | insert |
|---|---|---|---|
| raw better-sqlite3, prepared once | 3.9 | 34.9 | 69.4 |
| Kysely | 41.5 | 93.3 | 108.8 |
| Kysely + statement cache in the dialect's database object | 9.7 | 63.8 | 81.8 |
| Drizzle sync | 66.6 | 144.7 | 116.2 |
| Drizzle sync, `.prepare()`d | 4.8 | 70.7 | — |
| Drizzle sqlite-proxy + mutex (the async-safe variant) | 71.0 | 145.7 | 120.9 |
| Worker-thread round trip (§5) | 78 | | |

Most of Kysely's overhead is better-sqlite3 `prepare()` on every call; caching
statements by SQL text brings it within 6 µs of raw.

## 5. Main-thread blocking on the 4 GB fixture

`npx tsx src/bench/blocking.ts …` and `src/bench/followup.ts …`. Values are the
longest event-loop stall during the operation.

### FTS5 queries (all channels visible unless noted; 'the' matches 3,073,548 docs)

| Query | cold | warm |
|---|---|---|
| rare term (148 hits), newest 50 | 14 ms | 0 ms |
| rare term, `ORDER BY rank` | 35 ms | 1 ms |
| mid term (5,274 hits), `ORDER BY rank` | 580 ms | 28 ms |
| 'the', newest 50 | 6–14 ms | 0 ms |
| 'the', newest 50 + `snippet()` | 1–15 ms | 1 ms |
| phrase "the game", newest 50 | 21 ms | 1 ms |
| prefix 'kalo*', newest 50 | 25 ms | 8 ms |
| prefix 'ka*', newest 50 | 347–350 ms | 232–235 ms |
| 'the', `ORDER BY rank` (bm25 over all hits) | 4,232–4,530 ms | 2,663–2,902 ms |
| 'the OR game OR tonight', `ORDER BY rank` | 4,436–4,446 ms | 2,810–2,827 ms |
| prefix 'ka*', `ORDER BY rank` | 3,138–3,333 ms | 1,796–1,832 ms |
| 'the', rank among newest 1000: `rowid >= floor ORDER BY rank` | 20,110 ms | 3,148 ms |
| 'the', rank among newest 1000: `rowid >= floor ORDER BY bm25()` | 286 ms | 180 ms |
| 'the', rank among newest 1000: subquery, then `ORDER BY bm25()` | **170 ms** | **70 ms** |
| 'the OR game OR tonight', same subquery | 229 ms | 76 ms |
| 'ka*', same subquery | 586 ms | 575 ms |
| 'the', newest 50, UNINDEXED `channel_id =` quietest channel | 539–553 ms | 22 ms |
| 'the', newest 50, UNINDEXED `channel_id =` channel with no messages | **43,652 ms** | 43,154 ms |
| 'the' AND indexed `chan:` quietest channel | 22 ms | 0 ms |
| 'the' AND indexed `chan:` channel with no messages | **1 ms** | 0 ms |
| 'the' AND (`chan:` any of 5 channels) | 27 ms | 1 ms |
| `count(*)` of hits for 'the' | 184–186 ms | 94–97 ms |
| history page, 50 newest in busiest channel (B-tree) | 5 ms | 0 ms |

The `chan` variant is an FTS5 table with the channel ID as an indexed token column
(`message_fts_chan(content, chan, message_id UNINDEXED)`, built from the existing
index in 58 s). better-sqlite3 has no `interrupt()` and no progress handler
(its `Database` methods: prepare transaction pragma explain backup serialize
function aggregate table loadExtension exec close defaultSafeIntegers unsafeMode),
so a running statement cannot be cancelled; only the query shape can bound it.

### Snapshots

| Operation | Result |
|---|---|
| `.backup()` on main, 100 pages/step | 8.9 s, max block **800 ms** (no memory cap: 7.6 s, 374 ms) |
| `.backup()` on main, 1,000 pages/step | 11.4 s, max block **2,065 ms** (no cap: 7.4 s, 1,029 ms) |
| `.backup()` on main, 10,000 pages/step | 9.6 s, max block 2,256 ms (no cap: 1,058 ms) |
| `.backup()` on main, 100,000 pages/step | 11.6 s, max block 2,767 ms (no cap: 1,648 ms) |
| `.backup()` from the writer connection, app writing 100 rows/s | 9.9 s, 0 restarts, max block 2,129 ms |
| `.backup()` from a second connection, app writing 100 rows/s | **never completes**: 15,591 restarts in 180 s |
| `.backup()` on a worker thread, app writing 100 rows/s | **never completes**: 17,856 restarts in 180 s |
| `VACUUM INTO` on main | **44.7 s** block |
| `VACUUM INTO` on a worker thread, app writing 100 rows/s | completes in **39.8 s**; main max block 27.5 ms; main write p99 4.1 ms, max 26.4 ms |

The `.backup()` stalls are a handful of long gaps (p99 gap 2.8–9.7 ms), not per-step
cost, and step size does not remove them; they shrink without the memory cap but
stay above 300 ms.

### Maintenance

| Operation | Main-thread block |
|---|---|
| `PRAGMA optimize=0x10002`, 4 GB DB that was never analysed | **28.9 s** |
| `PRAGMA optimize` once stats exist | 0.5 ms |
| `PRAGMA analysis_limit=1000; ANALYZE` | **34.2 s** |
| `ANALYZE message` / `search_doc` / `message_fts_content` / `message_fts_data` (limit 1000, each) | 19.5 s / 4.4 s / 9.4 s / 9.0 s |
| `PRAGMA optimize=0x10002` on a new empty DB | 0.9 ms |
| retention: delete messages + FTS + search_doc, batches of 100 / 500 / 2,000 | 52 / 64 / 171 ms per batch |
| freelist after deleting 90k messages | 21,629 pages (88.6 MB) |
| `PRAGMA incremental_vacuum(1000)` / `(10000)` / all (≈10.6k) | 46 / 265 / 212 ms |
| FTS5 `'merge', 100` / `'merge', 1000` | 9 / 63 ms |
| FTS5 `'optimize'` (full merge) | **9.2 s** |

### Worker thread

| Measurement | Result |
|---|---|
| point lookup by id: main thread vs worker round trip | 5 µs vs 78 µs |
| `ORDER BY rank` 'the' on the worker while main writes 100 rows/s | worker 4.6 s; main max block 2.0 ms, write p99 0.5 ms |

## 6. Kysely's `await` never yields to I/O

A loop of 5,000 awaited `createMessage` calls ran 1,276 ms without a single timer
tick: Kysely on better-sqlite3 resolves through microtasks only. Jobs that loop over
queries must yield (`setImmediate`) between batches; the drain and reindex here do.
