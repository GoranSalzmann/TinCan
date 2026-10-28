# 04. Feature Module System

Defines how features are packaged, toggled, wired together and exposed to clients.
Server side first, then client side.

## 1. Goals

- Every user-facing feature can be turned off by config.
- Turning a module off removes its routes, WS handlers, migrations and UI.
- Modules cannot reach into each other; they communicate via events and shared ports.
- Boot fails fast, with a readable message, when config is inconsistent.

## 2. Module inventory (v1)

| Module ID | Purpose | Depends on modules | Needs ports |
|---|---|---|---|
| `core` | Gateway, config, events, health. Always on, not toggleable | none | db, pubsub |
| `accounts` | Users, profiles, sessions | core | db, auth |
| `invites` | Invite creation and redemption | accounts | db |
| `roles` | Roles, permissions, overrides | accounts | db |
| `channels` | Channel and category CRUD | roles | db |
| `text-chat` | Messages, history, edit/delete, replies, mentions | channels | db, pubsub |
| `read-state` | Unread/mention tracking | text-chat | db |
| `uploads` | Attachments, avatars | accounts | storage, db |
| `reactions` | Emoji reactions | text-chat | db |
| `search` | Full-text message search | text-chat | db |
| `link-previews` | Server-side URL unfurling | text-chat, uploads | storage (cache) |
| `voice` | Voice channels, LiveKit tokens, presence | channels, roles | livekit |
| `video` | Camera publishing permission/presets | voice | livekit |
| `screenshare` | Screenshare presets/permission | voice | livekit |
| `voice-e2ee` | Key distribution for E2EE media | voice | none (uses gateway) |
| `recording` | Egress recording | voice | livekit egress, storage, redis |
| `moderation` | Kick/ban/timeout/server-mute | roles, voice(optional) | db |
| `audit-log` | Records admin actions | roles | db |
| `metrics` | Prometheus endpoint | core | none |


OIDC login is **not a module**: it is an auth adapter enabled through `adapters.auth.kinds` (05 §3.4, 11 §1.7). It has no routes of its own beyond `/auth/oidc/*`, which belong to `accounts`.

`video` and `screenshare` are separate so a Host can allow voice+screenshare but
not webcams (or vice versa).

## 3. Module manifest

```ts
interface ModuleManifest {
  id: string;                       // unique, kebab-case
  version: string;                  // semver; informational
  dependsOn: string[];              // hard module dependencies
  optionalDependsOn?: string[];     // enhance behaviour if present
  conflictsWith?: ConflictRule[];   // e.g. recording vs voice-e2ee
  requiresPorts: PortName[];        // db | storage | pubsub | auth | livekit
  configSchema?: ZodSchema;         // module's own config section
  migrations?: Migration[];         // owned tables, applied only if enabled
  register(ctx: ModuleContext): void | Promise<void>;
}

interface ModuleContext {
  config: ModuleConfig;
  ports: Ports;                     // only the ports it declared
  events: EventBus;                 // typed publish/subscribe
  http: RouteRegistrar;             // add REST routes
  gateway: GatewayRegistrar;        // add WS op handlers + event projections
  capabilities: CapabilityRegistrar;// declare flags exposed to clients
  permissions: PermissionRegistrar; // declare permission bits (see 11)
  jobs: JobScheduler;               // periodic/background tasks
  log: Logger;
}
```

A module's `register` is the only place it touches the framework. It receives only
the ports it declared, so an accidental dependency (e.g. `reactions` grabbing
`livekit`) is a type error.

> **As built in M1 (2026-10-28).** `ModuleContext` differs from the sketch above in four ways:
> `permissions` is absent until `roles` exists (M2); `api` is a small registry (`provide(id, obj)` / `get(id)`) for the
> `ModuleApi` of §5; `security` lets `accounts` register the authenticator (`fromToken`, `fromTicket`) and request gates
> (the setup gate returns `SETUP_REQUIRED`); `capabilities.instance(fn)` lets `accounts` supply the instance name, signup
> policy and setup state. `ctx.http` is a Fastify scope under `/api/v1`, created per module, so a disabled module has no
> routes. Env overrides: `TINCAN_` prefix, `__` nests, `SNAKE_CASE` becomes camelCase, and under `modules` the module id is
> kebab-case (`TINCAN_MODULES__TEXT_CHAT__ENABLED`); a variable ending in `_FILE` reads its value from that file.
> The boot matrix runs over the shipped modules plus stand-ins for the rest of §2 (`modules.matrix.test.ts`).

## 4. Boot sequence

1. **Load config** (YAML/TOML + env overrides). Validate against the composed zod schema (core + each *enabled* module's `configSchema`).
2. **Resolve adapters** for each port from `adapters:` section; instantiate; run adapter health checks.
3. **Resolve module graph:** collect enabled modules, topologically sort by `dependsOn`, detect cycles, missing dependencies, and `conflictsWith` hits.
4. **Run migrations** for core + enabled modules, in dependency order, inside per-module transactions where the engine allows. Record applied versions in `_migrations` with module ID.
5. **Register modules** in order; each registers routes, handlers, capabilities, permission bits, jobs.
6. **Freeze registries**, print the resolved graph (see §8), start HTTP/WS listeners.
7. Emit `core.ready`.

Failures at steps 1 to 4 abort with a non-zero exit and an actionable message, e.g.:

```
Config error: module "screenshare" is enabled but its dependency "voice" is disabled.
  → enable modules.voice, or disable modules.screenshare
```

## 5. Dependency, conflict and warning rules

- **Hard dependency missing** → refuse to boot.
- **Conflict** → refuse or warn depending on rule severity:
  - `voice-e2ee` + `recording`: **error** ("recorded media would be undecodable or E2EE would be bypassed"). Host must choose.
  - `voice-e2ee` + `link-previews`: no conflict (text only).
  - `search` + Postgres without `pg_trgm`/FTS configured: **warn**, falls back to basic LIKE (applies once the post-v1 Postgres adapter exists, 18 T32).
- **Disabling a module with existing data:** tables are kept (never dropped automatically). Re-enabling restores the feature. A CLI `module purge <id>` (explicit, confirmed) can delete a module's data.
- **Module data ownership:** a module may *read* another module's data only through that module's exported read interface (a small typed `ModuleApi` object registered on `ctx.api`). It never queries another module's tables directly.

## 6. Event bus

Typed, in-process pub/sub, with the pubsub *port* bridging events that must cross
nodes.

```ts
interface Events {
  "user.created": { userId: string };
  "message.created": { message: Message };
  "message.updated": { ... }; "message.deleted": { ... };
  "channel.created" | "channel.updated" | "channel.deleted": { ... };
  "voice.participant.joined": { channelId; userId; at };
  "voice.participant.left": { channelId; userId; at };
  "voice.track.published": { channelId; userId; kind: "camera"|"screen"|"mic" };
  "voice.track.unpublished": { ... };
  "member.banned" | "member.kicked": { ... };
  "role.updated": { ... };
}
```

Rules:
- Handlers must be idempotent (webhook duplicates, retries).
- Events are facts, not commands. A handler failing never fails the publisher; it is logged and counted.
- Events are not a delivery guarantee: they live in memory and are lost on a crash or a failed handler. Anything that **must** happen is also covered by a level-triggered path that re-derives the desired state from the DB:
  - Enforcement in voice (removing banned or kicked users, applying permission changes, rotating E2EE keys) is repeated by the voice reconciler on every pass (05 §6.3, 18 T25).
  - Derived data (the search index) is fed from a core outbox written in the same transaction as the source row, not from the bus (05 §3.1, 06 §3.14, 18 T29).
- Each event carries the request ID of the use case that published it, so a failed handler's log line traces back to its request (18 T34).
- Events flagged `broadcast: true` are forwarded over the pubsub port to other nodes; the rest stay local.
- The gateway subscribes to the bus to produce client-facing events (e.g. `message.created` → WS `MESSAGE_CREATE` to authorised sockets).

Example decoupling: `moderation` publishes `member.banned`; `voice` subscribes and
disconnects the person from LiveKit; `audit-log` subscribes and records it.
Moderation knows nothing about voice or audit-log. If the LiveKit disconnect
fails, the next voice reconciler pass removes the person anyway.

## 7. Capability discovery

`GET /api/v1/capabilities` (unauthenticated minimal subset; full set after auth):

```json
{
  "server": { "name": "...", "version": "1.2.0", "apiVersion": 3 },
  "features": {
    "text-chat": true, "uploads": { "maxBytes": 26214400 },
    "voice": { "e2ee": true },
    "video": true,
    "screenshare": { "presets": ["720p30","1080p30","1080p60"], "maxBitrateKbps": 6000 },
    "reactions": false, "search": true, "recording": false
  },
  "limits": { "messageMaxChars": 4000 },
  "auth": { "methods": ["local","oidc"], "signup": "invite-only" }
}
```

- Clients hide or disable UI for absent features.
- The gateway also rejects ops for disabled features (`ERR_FEATURE_DISABLED`), so a stale or hostile client cannot bypass the UI.
- `apiVersion` is an integer incremented on breaking protocol changes; clients refuse to connect when `apiVersion` is outside their supported range and show an upgrade message (N-010).
- Capabilities may also be **per user** (e.g. camera allowed only for role X); the authenticated response includes effective permissions (11).

## 8. Boot output (self-hoster visibility)

```
Tin Can 1.0.0  (apiVersion 1)
Adapters : database=sqlite  storage=local  pubsub=memory  auth=local
Modules  : core accounts invites roles channels text-chat read-state
           uploads voice video screenshare voice-e2ee moderation audit-log
Disabled : reactions search link-previews recording metrics
Warnings : none
Listening: http://0.0.0.0:3000   LiveKit: wss://chat.example.com/livekit
```

`GET /api/admin/modules` (owner only) returns the same data.

## 9. Configuration

Single `config.yaml`, env var overrides (`TINCAN_MODULES__VOICE__ENABLED=false`; the `SHC_` prefix of the first draft is gone),
secrets via env or `*_FILE` indirection (Docker secrets). Validated by zod at
boot; unknown keys are an error (catches typos).

```yaml
instance: { name: "Our Place", publicUrl: "https://chat.example.com" }
adapters:
  database: { kind: sqlite, path: /data/app.db }     # postgres: post-v1 (18 T32)
  storage:  { kind: local,  path: /data/files }      # s3: post-v1
  pubsub:   { kind: memory }                         # redis: post-v1
  auth:     { kinds: [local] }                       # [local, oidc]
livekit: { url: wss://chat.example.com/livekit, apiKey: ..., apiSecret: ... }
modules:
  accounts:   { signup: invite-only }
  uploads:    { enabled: true, maxBytes: 26214400, userQuotaBytes: 2147483648, diskWarnPercent: 85 }
  voice:      { enabled: true, e2ee: true }
  video:      { enabled: true }
  screenshare:{ enabled: true, maxBitrateKbps: 6000 }
  reactions:  { enabled: false }
```

- `core`, `accounts`, `roles`, `channels` are always on (cannot be disabled; the platform has no meaning without them). Everything else is optional.
- **Restart to apply** is the v1 model. Runtime toggling from an admin UI is a possible later addition and would only need to write the config and trigger a graceful restart.
- A `config check` CLI validates a file without starting the server.

## 10. Client-side modularity

The web/desktop client mirrors the server's modules.

```ts
interface ClientModule {
  id: string;                         // matches server module id
  requiresCapability: string[];       // e.g. ["voice"]
  register(host: ClientHost): void;
}
interface ClientHost {
  slots: {
    sidebarSection(def): void;        // e.g. voice channel list
    channelView(type, component): void; // text view, voice view
    toolbarButton(def): void;
    settingsPane(def): void;
    messageDecorator(def): void;      // reactions bar, link previews
    contextMenuItem(target, def): void;
  };
  store: StoreRegistrar;              // contribute a Zustand slice
  gateway: ClientGatewayRegistrar;    // handle server events
  platform: PlatformBridge;           // desktop vs web capabilities
}
```

- At startup the client fetches capabilities, then registers only modules whose
  `requiresCapability` are satisfied.
- The shell (layout, routing, auth, gateway connection) knows nothing about
  specific features; it renders whatever slots are filled.
- Lazy-load heavy modules (voice with livekit-client and the denoiser WASM) so
  text-only users and first paint stay light.
- A module that is absent leaves no dead UI and no dead network calls.

## 11. Testing the module system (summary; full plan in 16)

- Boot-matrix test: each module alone (with deps), each module removed from the full set, full set. All must boot and pass `/capabilities` shape checks.
- Static check: lint rule forbidding imports across `modules/*` directories except via `ModuleApi` types.
- Conflict-rule unit tests.

## 12. Why not a full plugin system?

A runtime plugin loader needs a sandbox, a stable public SDK, versioning and a
trust model. Large effort, and it would freeze internal APIs. The manifest,
registrars and event bus are shaped so that this can be built later as an
additional layer. Not a v1 goal (01, ADR-003).

## Open items
- Which modules are truly non-toggleable beyond core/accounts/roles/channels? (`invites` off = how do people join? Likely allow "open signup" or manual account creation by admin.)
- Whether `read-state` should be a separate module or part of `text-chat` (leaning separate; costs little).
- Admin UI for module toggles: v1 or later?
