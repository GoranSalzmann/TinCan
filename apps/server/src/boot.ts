// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import pino, { type Logger as PinoLogger } from "pino";
import { LocalAuthAdapter } from "@tincan/auth";
import { coreMigrations, openSqlite, sql, type Db, type ModuleMigrations } from "@tincan/db";
import { MemoryPubSub, type PubSub } from "@tincan/pubsub";
import { API_PREFIX, GATEWAY_DEFAULTS, GATEWAY_PATH } from "@tincan/shared";
import { LocalStorage, type Storage } from "@tincan/storage";
import type { CoreConfig } from "./config/schema.js";
import { ConfigError } from "./config/errors.js";
import { InProcessEventBus } from "./framework/events.js";
import { Scheduler } from "./framework/jobs.js";
import { Outbox } from "./framework/outbox.js";
import { ApiMap, CapabilityStore, type BootDescription, type KernelFacade } from "./framework/kernel.js";
import { resolveModules, type ResolvedModules } from "./framework/loader.js";
import type {
  AnyManifest,
  AuthPort,
  GatewayRegistrar,
  Logger,
  ModuleContext,
  PortName,
  Ports,
  SecurityRegistrar,
} from "./framework/types.js";
import { handleConnection } from "./gateway/connection.js";
import { GatewayHub } from "./gateway/hub.js";
import { createHttpApp, NODE_ID, type SecurityState } from "./http/app.js";
import { ALL_MODULES } from "./modules/index.js";
import { API_VERSION, VERSION } from "./version.js";

export interface BootOptions {
  config: CoreConfig;
  /** Modules to choose from; defaults to everything in this build. Tests pass synthetic ones. */
  modules?: readonly AnyManifest[];
  /** Start listening (default true). Tests that use `app.inject` pass false. */
  listen?: boolean;
  logger?: PinoLogger;
  /** Snapshot the database before applying pending migrations on an existing install (06 §8). Default true. */
  backupBeforeMigrate?: boolean;
  gateway?: {
    heartbeatIntervalMs?: number;
    identifyTimeoutMs?: number;
    opBurst?: number;
    opPerSecond?: number;
    ringBufferEvents?: number;
  };
}

export interface RunningApp {
  app: FastifyInstance;
  description: BootDescription;
  /** The human-readable boot output of 04 §8. */
  banner: string;
  graph: ResolvedModules;
  hub: GatewayHub;
  events: InProcessEventBus;
  ports: Ports;
  scheduler: Scheduler;
  outbox: Outbox;
  /** Module APIs (04 §5), for tests and the admin CLI. */
  apis: ApiMap;
  /** `http://host:port` once listening. */
  address: string | null;
  close(): Promise<void>;
}

export function createLogger(config: CoreConfig): PinoLogger {
  return pino({
    level: config.log.level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "*.password",
        "*.newPassword",
        "*.currentPassword",
        "*.token",
        "*.ticket",
      ],
      censor: "[redacted]",
    },
  });
}

/** Boot step 2: instantiate the configured adapters and prove they work (04 §4). */
export async function createPorts(config: CoreConfig, pubsubNow?: () => number): Promise<Ports> {
  const dbPath = resolve(config.adapters.database.path);
  const db = openSqlite({ path: dbPath });
  try {
    await db.health();
  } catch (err) {
    await db.close();
    throw new ConfigError([
      {
        message: `the database at ${dbPath} cannot be opened: ${(err as Error).message}`,
        hint: "check adapters.database.path and that the data directory is writable",
      },
    ]);
  }
  mkdirSync(resolve(config.adapters.storage.path), { recursive: true });
  const storage: Storage = new LocalStorage(config.adapters.storage.path);
  const pubsub: PubSub = new MemoryPubSub(pubsubNow ? { now: pubsubNow } : {});
  const auth: AuthPort = {
    kinds: config.adapters.auth.kinds,
    local: (opts) => new LocalAuthAdapter(opts),
  };
  return { db, storage, pubsub, auth, ...(config.livekit ? { livekit: config.livekit } : {}) } as Ports;
}

export function availablePorts(config: CoreConfig): Set<PortName> {
  const ports = new Set<PortName>(["db", "storage", "pubsub", "auth"]);
  if (config.livekit) ports.add("livekit");
  return ports;
}

async function hasAppliedMigrations(db: Db): Promise<boolean> {
  try {
    const r = await sql<{ n: number }>`SELECT count(*) AS n FROM _migrations`.execute(db.query);
    return (r.rows[0]?.n ?? 0) > 0;
  } catch {
    return false; // no _migrations table: a brand-new database
  }
}

export function describeBoot(
  config: CoreConfig,
  graph: ResolvedModules,
  address: string | null,
): BootDescription {
  return {
    version: VERSION,
    apiVersion: API_VERSION,
    adapters: {
      database: config.adapters.database.kind,
      storage: config.adapters.storage.kind,
      pubsub: config.adapters.pubsub.kind,
      auth: [...config.adapters.auth.kinds],
    },
    modules: graph.order.map((m) => ({ id: m.id, version: m.version })),
    disabled: graph.disabled,
    warnings: graph.warnings,
    listening: address,
    livekit: config.livekit?.url ?? null,
  };
}

/** The boot output of 04 §8. */
export function formatBanner(d: BootDescription): string {
  const pad = "           ";
  const wrap = (items: string[]) => {
    const lines: string[] = [];
    let cur = "";
    for (const it of items) {
      if ((cur + " " + it).length > 70 && cur) {
        lines.push(cur);
        cur = it;
      } else cur = cur ? `${cur} ${it}` : it;
    }
    if (cur) lines.push(cur);
    return lines.join(`\n${pad}`);
  };
  return [
    `Tin Can ${d.version}  (apiVersion ${d.apiVersion})`,
    `Adapters : database=${d.adapters.database}  storage=${d.adapters.storage}  pubsub=${d.adapters.pubsub}  auth=${d.adapters.auth.join(",")}`,
    `Modules  : ${wrap(d.modules.map((m) => m.id)) || "none"}`,
    `Disabled : ${d.disabled.length ? wrap(d.disabled) : "none"}`,
    `Warnings : ${d.warnings.length ? d.warnings.join("; ") : "none"}`,
    `Listening: ${d.listening ?? "not listening"}   LiveKit: ${d.livekit ?? "not configured"}`,
  ].join("\n");
}

/** Boot sequence of 04 §4. Steps 1 (config) happens before this call. */
export async function boot(opts: BootOptions): Promise<RunningApp> {
  const { config } = opts;
  const logger = opts.logger ?? createLogger(config);
  const available = opts.modules ?? ALL_MODULES;

  // 2 + 3: adapters, then the module graph. Both fail fast with a readable message.
  const ports = await createPorts(config);
  let graph: ResolvedModules;
  try {
    graph = resolveModules({ available, rawModules: config.modules, ports: availablePorts(config) });
  } catch (err) {
    await ports.db.close();
    throw err;
  }

  // 4: migrations for core + enabled modules, in dependency order.
  const migrations: ModuleMigrations[] = [coreMigrations];
  for (const m of graph.order)
    if (m.migrations && m.migrations.module !== coreMigrations.module) migrations.push(m.migrations);
  const dataDir = resolve(config.dataDir);
  try {
    await ports.db.migrate(migrations, {
      log: (line) => logger.info(line),
      beforeApply: async (pending) => {
        if (opts.backupBeforeMigrate === false || !(await hasAppliedMigrations(ports.db))) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dest = join(dataDir, "backups", `pre-migrate-${stamp}.db`);
        logger.info({ dest, pending: pending.length }, "backing up the database before migrating");
        await ports.db.snapshot(dest);
      },
    });
  } catch (err) {
    await ports.db.close();
    throw err;
  }

  // 5: build the runtime and register modules.
  const events = new InProcessEventBus({ log: logger, pubsub: ports.pubsub, nodeId: NODE_ID });
  const scheduler = new Scheduler(logger);
  const capabilities = new CapabilityStore(config);
  const gw = opts.gateway ?? {};
  const hub = new GatewayHub(
    gw.ringBufferEvents === undefined ? {} : { ringBufferEvents: gw.ringBufferEvents },
  );
  const outbox = new Outbox(ports.db, logger.child({ module: "outbox" }));
  scheduler.every("outbox.drain", 1000, async () => void (await outbox.drain()), {
    jitter: 0,
    runOnStart: true,
  });
  const security: SecurityState = { authenticator: null, gates: [] };
  const apis = new ApiMap();

  const app = await createHttpApp({ logger, trustProxy: config.server.trustProxy, security });

  let address: string | null = null;
  const facade: KernelFacade = {
    capabilities,
    hub,
    events,
    scheduler,
    security,
    describe: () => describeBoot(config, graph, address),
    health: () => ports.db.health(),
  };
  apis.provide("kernel", facade);

  const allowedOrigins = new Set([
    new URL(config.instance.publicUrl).origin,
    ...config.server.allowedOrigins.map((o) => new URL(o).origin),
  ]);
  const heartbeatIntervalMs = gw.heartbeatIntervalMs ?? GATEWAY_DEFAULTS.heartbeatIntervalMs;

  // Probes and the gateway socket are runtime plumbing, not module features (05 §8, 07 §4).
  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await ports.db.health();
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });
  app.get(
    GATEWAY_PATH,
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const origin = req.headers.origin;
        // Browsers always send Origin; non-browser clients (desktop, CLI) may omit it.
        if (origin !== undefined && !allowedOrigins.has(origin)) {
          await reply
            .status(403)
            .send({ error: { code: "PERMISSION_DENIED", message: "Origin not allowed." } });
        }
      },
    },
    (socket, req) => {
      const v = (req.query as Record<string, string | undefined>).v;
      handleConnection(socket, v, {
        hub,
        authenticator: () => security.authenticator,
        log: req.log,
        heartbeatIntervalMs,
        identifyTimeoutMs: gw.identifyTimeoutMs ?? GATEWAY_DEFAULTS.identifyTimeoutMs,
        maxSendQueueBytes: GATEWAY_DEFAULTS.maxSendQueueBytes,
        opLimit: { burst: gw.opBurst ?? 40, perSecond: gw.opPerSecond ?? 20 },
      });
    },
  );

  const gatewayRegistrar: GatewayRegistrar = {
    onCommand: (cmd, handler) => {
      if (hub.commands.has(cmd)) throw new Error(`gateway command '${cmd}' registered twice`);
      hub.commands.set(cmd, handler);
    },
    contributeReady: (fn) => void hub.readyContributors.push(fn),
    dispatchToUser: (userId, t, d) => hub.dispatchToUser(userId, t, d),
    dispatchToUsers: (ids, t, d) => hub.dispatchToUsers(ids, t, d),
    dispatchToAll: (t, d) => hub.dispatchToAll(t, d),
    dispatchToChannel: (c, t, d, except) => hub.dispatchToChannel(c, t, d, except),
    provideChannelAccess: (fn) => {
      hub.channelAccess = fn;
    },
    setChannelAccess: (userId, channels) => hub.setChannels(userId, channels),
    isOnline: (userId) => hub.isOnline(userId),
    onlineUserIds: () => hub.onlineUserIds(),
    onPresenceChange: (fn) => void hub.presenceListeners.push(fn),
  };
  const securityRegistrar: SecurityRegistrar = {
    setAuthenticator: (fn) => {
      security.authenticator = fn;
    },
    addGate: (fn) => void security.gates.push(fn),
  };

  const makeLogger = (id: string): Logger => logger.child({ module: id });
  for (const m of graph.order) {
    await app.register(
      async (scope) => {
        const ctx: ModuleContext<unknown, PortName> = {
          id: m.id,
          config: graph.configs.get(m.id),
          core: config,
          ports: Object.fromEntries(m.requiresPorts.map((p) => [p, ports[p]])) as unknown as Ports,
          events,
          http: scope,
          gateway: gatewayRegistrar,
          capabilities,
          security: securityRegistrar,
          jobs: scheduler,
          outbox,
          api: apis,
          log: makeLogger(m.id),
        };
        await m.register(ctx);
      },
      { prefix: API_PREFIX },
    );
  }

  scheduler.every("gateway.sweep", 30_000, () => void hub.sweep());

  // 6: freeze registries, then listen.
  await app.ready();
  let listening = false;
  if (opts.listen !== false) {
    await app.listen({ host: config.server.host, port: config.server.port });
    listening = true;
    const addr = app.server.address();
    if (addr && typeof addr === "object") {
      const host =
        config.server.host === "0.0.0.0" || config.server.host === "::" ? "localhost" : config.server.host;
      address = `http://${host}:${addr.port}`;
    }
  }
  scheduler.start();

  const description = describeBoot(config, graph, address);
  // 7
  events.emit("core.ready", {});

  let closed = false;
  return {
    app,
    description,
    banner: formatBanner(description),
    graph,
    hub,
    events,
    ports,
    scheduler,
    outbox,
    apis,
    address,
    async close() {
      if (closed) return;
      closed = true;
      // Graceful shutdown (05 §1): stop accepting, tell sockets to resume elsewhere, flush, close the DB.
      hub.shutdown();
      await scheduler.stop();
      outbox.close();
      if (listening) await app.close();
      else await app.close();
      await events.idle();
      await ports.pubsub.close();
      await ports.db.close();
    },
  };
}
