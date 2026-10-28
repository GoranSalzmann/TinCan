# Spike T1 results (2026-10-28)

Raw output behind 03 ADR-005 and 18 T1. Same setup as `../d5-db/RESULTS.md`
(Node 24.22.1 in Docker; the benchmark container had `--cpus=4`, server and load
generator on the same host).

**Versions.** fastify 5.12.7, @fastify/websocket 11.3.4, @fastify/swagger 9.9.2,
fastify-type-provider-zod 7.0.0 · hono 4.13.14, @hono/node-server 1.19.17,
@hono/node-ws 1.3.1, @hono/zod-openapi 1.6.3 · zod 4.6.7, ws 8.22.0.
@hono/node-ws 1.3.1 still declares a peer dependency on @hono/node-server ^1 while
that package is at 2.1.5, so the spike pins node-server 1.x.

Both apps serve the same routes from the same zod schemas (`src/shared.ts`) and
hand the socket to the same framework-independent gateway (`src/gateway.ts`).
`createMessageUseCase` returns an extra `passwordHash` field on purpose.

## Feature checks (`npm run check`)

| Check | Fastify | Hono |
|---|---|---|
| POST valid -> status | 201 | 201 |
| internal field leaked in response (passwordHash) | no (stripped) | YES (leaked) |
| POST empty content -> status / error.code | 400 / VALIDATION_FAILED | 400 / VALIDATION_FAILED |
| POST bad :channelId -> status / error.code | 400 / VALIDATION_FAILED | 400 / VALIDATION_FAILED |
| POST malformed JSON -> status / error.code | 400 / BAD_REQUEST | 400 / BAD_REQUEST |
| POST 100 kB body (limit 64 KiB) -> status / error.code | 413 / PAYLOAD_TOO_LARGE | 413 / PAYLOAD_TOO_LARGE |
| GET ?limit=5 (coerced) -> status / items | 200 / 5 | 200 / 5 |
| GET ?limit=abc -> status / error.code | 400 / VALIDATION_FAILED | 400 / VALIDATION_FAILED |
| handler returns schema-violating body -> status | 500 (caught) | 200 (sent unchecked: {"id":123}) |
| OpenAPI version | 3.1.0 | 3.1.0 |
| OpenAPI paths | /api/v1/channels/{channelId}/messages, /api/v1/broken | same |
| request body schema carries maxLength 4000 | true | true |
| ULID pattern on path param | true | true |
| 201 response schema present | true | true |
| OpenAPI document validates (@readme/openapi-parser) | valid | valid |
| WS: HELLO, READY, HEARTBEAT_ACK, MESSAGE_CREATE | [10,"READY",11,"MESSAGE_CREATE"] | same |
| WS: foreign Origin rejected before upgrade (HTTP status) | 403 | 403 |
| WS: bad token -> close code | 4004 | 4004 |
| WS: valid 70 KiB frame (limit 64 KiB) | closed 1009 (too big) | accepted and processed |
| WS: valid 20 MiB frame | closed 1009 (too big) | accepted and processed |

- Fastify's zod serializer parses every response through its schema, which strips
  unknown keys and turns a violating body into a 500. @hono/zod-openapi 1.6.3 has
  no runtime response validation (no option for it in its types); the response
  schema only types `c.json()` and the OpenAPI document.
- @fastify/websocket passes `options` to `ws` (`maxPayload: 65536` here). @hono/node-ws
  1.3.1 creates `new WebSocketServer({ noServer: true })` with no way to pass
  options, so frames up to ws's default 100 MiB are buffered before app code sees
  them. Workaround: attach a plain `ws` server to the Node server's `upgrade`
  event yourself.
- Origin checks run before the upgrade in both: a `preValidation` hook in Fastify, a
  middleware ahead of `upgradeWebSocket` in Hono.

## Throughput and fan-out (`npm run bench`)

```
## fastify: startup 235 ms (imports + routes + listen), RSS at ready 114 MB
  GET history (50 msgs, zod response)     8,162 req/s, p99 11 ms
  POST create (zod body, 201)            16,085 req/s, p99 6 ms
  POST invalid body (400 envelope)       12,292 req/s, p99 7 ms
  gateway fan-out 200 sockets, 20 msg/s  40,000/40,000 delivered, p50 1.7 ms, p99 3.4 ms, max 21.0 ms
  gateway fan-out 1000 sockets, 50 msg/s 200,000/200,000 delivered, p50 4.7 ms, p99 10.7 ms, max 15.5 ms
  RSS after runs 269 MB

## hono: startup 133 ms (imports + routes + listen), RSS at ready 96 MB
  GET history (50 msgs, zod response)     7,003 req/s, p99 13 ms   (response not validated)
  POST create (zod body, 201)             8,418 req/s, p99 11 ms
  POST invalid body (400 envelope)        7,838 req/s, p99 11 ms
  gateway fan-out 200 sockets, 20 msg/s  40,000/40,000 delivered, p50 1.8 ms, p99 4.2 ms, max 12.8 ms
  gateway fan-out 1000 sockets, 50 msg/s 200,000/200,000 delivered, p50 4.9 ms, p99 9.9 ms, max 12.5 ms
  RSS after runs 332 MB
```

Fan-out is the same because both hand frames to `ws`; the framework only matters
up to the upgrade.

## Install footprint (fresh `npm i` of each stack)

| Stack | Packages | node_modules |
|---|---|---|
| fastify @fastify/websocket @fastify/swagger fastify-type-provider-zod zod | 70 | 27 MB |
| hono @hono/node-server@1 @hono/node-ws @hono/zod-openapi zod | 10 | 15 MB |
