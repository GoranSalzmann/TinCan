// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConfigIssue } from "../config/errors.js";
import { ConfigError } from "../config/errors.js";
import { formatZodIssues } from "../config/load.js";
import type { AnyManifest, PortName } from "./types.js";

export interface ResolvedModules {
  /** Enabled modules in dependency order. */
  order: AnyManifest[];
  disabled: string[];
  warnings: string[];
  /** Validated `modules.<id>` section of each enabled module (without `enabled`). */
  configs: Map<string, unknown>;
}

export interface ResolveInput {
  /** Every module this build knows. */
  available: readonly AnyManifest[];
  /** The raw `modules:` section of the config. */
  rawModules: Record<string, unknown>;
  /** Ports the configured adapters provide. */
  ports: ReadonlySet<PortName>;
}

function sectionOf(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * Boot step 3 (04 §4, §5): enabled set, missing dependencies, conflicts, missing ports, cycles,
 * topological order, then each enabled module's own config. Collects every problem before failing.
 */
export function resolveModules(input: ResolveInput): ResolvedModules {
  const { available, rawModules, ports } = input;
  const byId = new Map(available.map((m) => [m.id, m]));
  const issues: ConfigIssue[] = [];
  const warnings: string[] = [];

  for (const key of Object.keys(rawModules)) {
    if (!byId.has(key)) {
      issues.push({
        message: `modules.${key} is not a module in this build.`,
        hint: `available modules: ${available.map((m) => m.id).join(", ")}`,
      });
    }
  }

  const enabled = new Set<string>();
  for (const m of available) {
    const flag = sectionOf(rawModules[m.id]).enabled;
    if (flag !== undefined && typeof flag !== "boolean") {
      issues.push({ message: `modules.${m.id}.enabled must be true or false.` });
      continue;
    }
    if (m.alwaysOn) {
      if (flag === false) {
        issues.push({
          message: `module "${m.id}" cannot be disabled; Tin Can has no meaning without it.`,
          hint: `remove modules.${m.id}.enabled: false`,
        });
      }
      enabled.add(m.id);
    } else if (flag !== false) {
      enabled.add(m.id);
    }
  }

  for (const m of available) {
    if (!enabled.has(m.id)) continue;
    for (const dep of m.dependsOn) {
      if (!byId.has(dep)) {
        issues.push({ message: `module "${m.id}" needs "${dep}", which is not in this build.` });
      } else if (!enabled.has(dep)) {
        issues.push({
          message: `module "${m.id}" is enabled but its dependency "${dep}" is disabled.`,
          hint: `enable modules.${dep}, or disable modules.${m.id}`,
        });
      }
    }
    for (const rule of m.conflictsWith ?? []) {
      if (!enabled.has(rule.with)) continue;
      if (rule.severity === "error") {
        issues.push({
          message: `modules "${m.id}" and "${rule.with}" cannot both be enabled: ${rule.message}`,
          hint: `choose one: disable modules.${m.id} or modules.${rule.with}`,
        });
      } else {
        warnings.push(`"${m.id}" with "${rule.with}": ${rule.message}`);
      }
    }
    for (const port of m.requiresPorts) {
      if (!ports.has(port)) {
        issues.push({
          message: `module "${m.id}" needs the "${port}" port, which is not configured.`,
          hint:
            port === "livekit"
              ? "add a livekit: section (url, apiKey, apiSecret)"
              : `configure adapters.${port}`,
        });
      }
    }
  }

  const order = topoSort(
    available.filter((m) => enabled.has(m.id)),
    enabled,
    issues,
  );

  const configs = new Map<string, unknown>();
  for (const m of order) {
    const { enabled: _flag, ...rest } = sectionOf(rawModules[m.id]);
    if (!m.configSchema) {
      const keys = Object.keys(rest);
      if (keys.length > 0) {
        issues.push({
          message: `unknown setting ${keys.map((k) => `"modules.${m.id}.${k}"`).join(", ")}`,
          hint: `module "${m.id}" has no settings of its own`,
        });
      }
      configs.set(m.id, {});
      continue;
    }
    const parsed = m.configSchema.safeParse(rest);
    if (parsed.success) configs.set(m.id, parsed.data);
    else issues.push(...formatZodIssues(parsed.error, `modules.${m.id}`));
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    order,
    disabled: available.filter((m) => !enabled.has(m.id)).map((m) => m.id),
    warnings,
    configs,
  };
}

function topoSort(mods: AnyManifest[], enabled: Set<string>, issues: ConfigIssue[]): AnyManifest[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const edges = (m: AnyManifest) =>
    [...m.dependsOn, ...(m.optionalDependsOn ?? [])].filter((d) => enabled.has(d) && byId.has(d));
  const sorted: AnyManifest[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  let cyclic = false;

  const visit = (m: AnyManifest) => {
    const s = state.get(m.id);
    if (s === "done") return;
    if (s === "visiting") {
      if (!cyclic) {
        const loop = [...stack.slice(stack.indexOf(m.id)), m.id];
        issues.push({
          message: `modules depend on each other in a loop: ${loop.join(" → ")}.`,
          hint: "break the cycle by removing one dependsOn entry",
        });
      }
      cyclic = true;
      return;
    }
    state.set(m.id, "visiting");
    stack.push(m.id);
    for (const dep of edges(m)) visit(byId.get(dep)!);
    stack.pop();
    state.set(m.id, "done");
    sorted.push(m);
  };
  for (const m of mods) visit(m);
  return sorted;
}
