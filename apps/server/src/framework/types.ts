// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { LocalAuthAdapter, LocalAuthOptions } from "@tincan/auth";
import type { Db, ModuleMigrations } from "@tincan/db";
import type { PubSub } from "@tincan/pubsub";
import type { Storage } from "@tincan/storage";
import type { CoreConfig } from "../config/schema.js";
import type { EventBus } from "./events.js";
import type { JobScheduler } from "./jobs.js";

export type PortName = "db" | "storage" | "pubsub" | "auth" | "livekit";

export interface AuthPort {
  kinds: readonly ("local" | "oidc")[];
  /** The local adapter needs `accounts` to look credentials up; the port builds it around that. */
  local(opts: LocalAuthOptions): LocalAuthAdapter;
}

export interface LiveKitSettings {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export interface Ports {
  db: Db;
  storage: Storage;
  pubsub: PubSub;
  auth: AuthPort;
  livekit: LiveKitSettings;
}

/** The authenticated identity a request or gateway session acts as. Permissions join it in M2 (11 §2). */
export interface Actor {
  userId: string;
  sessionId: string;
  username: string;
  displayName: string;
  isInstanceOwner: boolean;
}

/**
 * Turns credentials into an Actor, or null if they are unknown, expired, revoked or the account is disabled.
 * `fromTicket` redeems a single-use gateway ticket (the web client's cookie never reaches JavaScript).
 */
export interface Authenticator {
  fromToken(token: string): Promise<Actor | null>;
  fromTicket(ticket: string): Promise<Actor | null>;
}

/** Runs before every route (setup gate, maintenance mode …). May throw an AppError to refuse. */
export type RequestGate = (req: FastifyRequest) => void | Promise<void>;

export interface SecurityRegistrar {
  setAuthenticator(fn: Authenticator): void;
  addGate(fn: RequestGate): void;
}

export interface GatewayCommandContext {
  actor: Actor;
  sessionId: string;
}
export type GatewayCommandHandler = (args: unknown, ctx: GatewayCommandContext) => Promise<void> | void;

export interface GatewayRegistrar {
  /** Handles a gateway command (07 §4.6). Commands of a module that is off answer FEATURE_DISABLED. */
  onCommand(cmd: string, handler: GatewayCommandHandler): void;
  /** Adds fields to the READY payload (channels, roles … arrive with their modules). */
  contributeReady(fn: (actor: Actor) => Promise<Record<string, unknown>> | Record<string, unknown>): void;
  dispatchToUser(userId: string, t: string, d: unknown): void;
  dispatchToAll(t: string, d: unknown): void;
}

export interface InstanceInfo {
  /** Community name; null until the first-run setup has named it. */
  name: string | null;
  signup: "invite-only" | "open" | "closed";
  setupRequired: boolean;
}

export interface CapabilityRegistrar {
  /** Exposes `features[id]` to clients: `true`, or an object of module limits. */
  feature(id: string, value: true | Record<string, unknown>): void;
  limit(name: string, value: number): void;
  /** Supplies the instance facts `accounts` owns (name, signup policy, setup state). Read on every request. */
  instance(fn: () => InstanceInfo): void;
}

/** Read interface a module offers others instead of letting them query its tables (04 §5). */
export interface ApiRegistry {
  provide<T extends object>(moduleId: string, api: T): void;
  get<T extends object>(moduleId: string): T | undefined;
}

export interface Logger {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface ModuleContext<C = unknown, P extends PortName = PortName> {
  readonly id: string;
  readonly config: C;
  readonly core: Readonly<CoreConfig>;
  /** Only the ports the manifest declared, so an accidental dependency is a type error. */
  readonly ports: Pick<Ports, P>;
  readonly events: EventBus;
  /** Routes registered here live under /api/v1 and exist only while the module is enabled. */
  readonly http: FastifyInstance;
  readonly gateway: GatewayRegistrar;
  readonly capabilities: CapabilityRegistrar;
  readonly security: SecurityRegistrar;
  readonly jobs: JobScheduler;
  readonly api: ApiRegistry;
  readonly log: Logger;
}

export interface ConflictRule {
  with: string;
  severity: "error" | "warn";
  message: string;
}

export interface ModuleManifest<C = unknown, P extends PortName = PortName> {
  /** Unique, kebab-case. */
  id: string;
  version: string;
  dependsOn: readonly string[];
  optionalDependsOn?: readonly string[];
  conflictsWith?: readonly ConflictRule[];
  requiresPorts: readonly P[];
  /** Always on and not toggleable (core, accounts, roles, channels). */
  alwaysOn?: boolean;
  /** The module's own `modules.<id>` section, without `enabled`. Unknown keys must be an error. */
  configSchema?: z.ZodType<C>;
  /** Owned tables and migrations, applied only while the module is enabled. */
  migrations?: ModuleMigrations;
  register(ctx: ModuleContext<C, P>): void | Promise<void>;
}

// The registry holds manifests of different config and port types side by side.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyManifest = ModuleManifest<any, PortName>;

export function defineModule<C = unknown, P extends PortName = never>(
  manifest: ModuleManifest<C, P>,
): AnyManifest {
  return manifest;
}
