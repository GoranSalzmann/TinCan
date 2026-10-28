// SPDX-License-Identifier: AGPL-3.0-or-later
import { API_VERSION, type Capabilities } from "@tincan/shared";
import type { CoreConfig } from "../config/schema.js";
import { DEFAULT_SOURCE_URL, VERSION } from "../version.js";
import type { GatewayHub } from "../gateway/hub.js";
import type { SecurityState } from "../http/app.js";
import type { InProcessEventBus } from "./events.js";
import type { Scheduler } from "./jobs.js";
import type { ApiRegistry, CapabilityRegistrar, InstanceInfo } from "./types.js";

/** Builds `/capabilities` (04 §7) from what enabled modules registered. */
export class CapabilityStore implements CapabilityRegistrar {
  readonly #features = new Map<string, true | Record<string, unknown>>();
  readonly #limits = new Map<string, number>();
  #instance: () => InstanceInfo = () => ({ name: null, signup: "closed", setupRequired: false });
  readonly #config: CoreConfig;

  constructor(config: CoreConfig) {
    this.#config = config;
  }

  feature(id: string, value: true | Record<string, unknown>): void {
    this.#features.set(id, value);
  }

  limit(name: string, value: number): void {
    this.#limits.set(name, value);
  }

  instance(fn: () => InstanceInfo): void {
    this.#instance = fn;
  }

  info(): InstanceInfo {
    return this.#instance();
  }

  build(): Capabilities {
    const inst = this.#instance();
    return {
      server: {
        name: inst.name ?? this.#config.instance.name,
        version: VERSION,
        apiVersion: API_VERSION,
        sourceUrl: this.#config.instance.sourceUrl ?? DEFAULT_SOURCE_URL,
      },
      features: Object.fromEntries(this.#features),
      limits: Object.fromEntries(this.#limits),
      auth: {
        methods: [...this.#config.adapters.auth.kinds],
        signup: inst.signup,
        setupRequired: inst.setupRequired,
      },
    };
  }

  /** Shape-only view for the matrix test: which features exist, no volatile values. */
  featureIds(): string[] {
    return [...this.#features.keys()].sort();
  }
}

export class ApiMap implements ApiRegistry {
  readonly #apis = new Map<string, object>();
  provide<T extends object>(moduleId: string, api: T): void {
    this.#apis.set(moduleId, api);
  }
  get<T extends object>(moduleId: string): T | undefined {
    return this.#apis.get(moduleId) as T | undefined;
  }
}

/** What `core` needs from the runtime. Provided through `ctx.api.get("kernel")`; it is core's private seam. */
export interface KernelFacade {
  capabilities: CapabilityStore;
  hub: GatewayHub;
  events: InProcessEventBus;
  scheduler: Scheduler;
  security: SecurityState;
  /** Resolved boot description, for `GET /admin/modules` and the boot output. */
  describe(): BootDescription;
  /** Called by the readiness probe. */
  health(): Promise<void>;
}

export interface BootDescription {
  version: string;
  apiVersion: number;
  adapters: { database: string; storage: string; pubsub: string; auth: string[] };
  modules: { id: string; version: string }[];
  disabled: string[];
  warnings: string[];
  listening: string | null;
  livekit: string | null;
}
