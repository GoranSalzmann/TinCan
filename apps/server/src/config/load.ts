// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { ConfigError, type ConfigIssue } from "./errors.js";
import { CoreConfigSchema, type CoreConfig } from "./schema.js";

export const ENV_PREFIX = "TINCAN_";

function camel(seg: string): string {
  return seg.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function kebab(seg: string): string {
  return seg.toLowerCase().replace(/_/g, "-");
}

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

type Tree = Record<string, unknown>;

function setPath(tree: Tree, path: string[], value: unknown): void {
  let node = tree;
  for (const seg of path.slice(0, -1)) {
    const next = node[seg];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      node = next as Tree;
    } else {
      const created: Tree = {};
      node[seg] = created;
      node = created;
    }
  }
  node[path[path.length - 1]!] = value;
}

/**
 * `TINCAN_ADAPTERS__DATABASE__PATH=/x` sets `adapters.database.path`; `TINCAN_MODULES__TEXT_CHAT__ENABLED=false`
 * sets `modules.text-chat.enabled` (04 §9). A variable ending in `_FILE` reads the value from that file
 * (Docker secrets): `TINCAN_SECURITY__INSTANCE_SECRET_FILE=/run/secrets/x`.
 */
export function applyEnv(raw: Tree, env: Record<string, string | undefined>, readFile = readFileSync): Tree {
  const out = structuredClone(raw);
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(ENV_PREFIX) || value === undefined) continue;
    let key = name.slice(ENV_PREFIX.length);
    let val: unknown;
    if (key.endsWith("_FILE")) {
      key = key.slice(0, -"_FILE".length);
      try {
        val = readFile(value, "utf8").replace(/\r?\n$/, "");
      } catch (err) {
        throw new ConfigError([
          { message: `${name} points to ${value}, which cannot be read: ${(err as Error).message}` },
        ]);
      }
    } else {
      val = coerce(value);
    }
    const segs = key.split("__").filter(Boolean);
    if (segs.length === 0) continue;
    const path = segs.map((s, i) => (segs[0]!.toLowerCase() === "modules" && i === 1 ? kebab(s) : camel(s)));
    setPath(out, path, val);
  }
  return out;
}

export function formatZodIssues(error: z.ZodError, prefix = ""): ConfigIssue[] {
  return error.issues.map((i) => {
    const path = [...(prefix ? [prefix] : []), ...i.path.map(String)].join(".");
    if (i.code === "unrecognized_keys") {
      return {
        message: `unknown setting ${i.keys.map((k) => `"${[path, k].filter(Boolean).join(".")}"`).join(", ")}`,
        hint: "check the spelling against the configuration reference (04 §9)",
      };
    }
    return { message: `${path || "(root)"}: ${i.message}` };
  });
}

export function parseCoreConfig(raw: unknown): CoreConfig {
  const result = CoreConfigSchema.safeParse(raw ?? {});
  if (!result.success) throw new ConfigError(formatZodIssues(result.error));
  return result.data;
}

export function readConfigFile(path: string): Tree {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError([
      {
        message: `cannot read ${path}: ${(err as Error).message}`,
        hint: "run `tincan init`, or pass --config <file>",
      },
    ]);
  }
  try {
    const doc = parseYaml(text) as unknown;
    if (doc === null || doc === undefined) return {};
    if (typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error("the top level must be a mapping");
    }
    return doc as Tree;
  } catch (err) {
    throw new ConfigError([{ message: `${path} is not valid YAML: ${(err as Error).message}` }]);
  }
}

/** Steps 1 of the boot sequence: file, then environment overrides, then validation. */
export function loadConfig(
  path: string | undefined,
  env: Record<string, string | undefined> = process.env,
): CoreConfig {
  const file = path ? readConfigFile(path) : {};
  return parseCoreConfig(applyEnv(file, env));
}
