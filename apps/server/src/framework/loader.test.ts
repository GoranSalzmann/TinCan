// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError } from "../config/errors.js";
import { resolveModules } from "./loader.js";
import { defineModule, type AnyManifest, type ConflictRule, type PortName } from "./types.js";

function mod(
  id: string,
  dependsOn: string[] = [],
  extra: Partial<{
    alwaysOn: boolean;
    optionalDependsOn: string[];
    conflictsWith: ConflictRule[];
    requiresPorts: PortName[];
    configSchema: z.ZodType;
  }> = {},
): AnyManifest {
  return defineModule({
    id,
    version: "1.0.0",
    dependsOn,
    requiresPorts: [],
    register: () => undefined,
    ...extra,
  });
}

const ALL_PORTS = new Set<PortName>(["db", "storage", "pubsub", "auth"]);
const resolve = (available: AnyManifest[], rawModules: Record<string, unknown> = {}, ports = ALL_PORTS) =>
  resolveModules({ available, rawModules, ports });

function failure(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

describe("module loader", () => {
  it("orders enabled modules by dependency, whatever the registry order", () => {
    const r = resolve([mod("c", ["b"]), mod("b", ["a"]), mod("a")]);
    expect(r.order.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("puts an enabled optional dependency first and ignores a disabled one", () => {
    const list = [mod("x", [], { optionalDependsOn: ["y"] }), mod("y")];
    expect(resolve(list).order.map((m) => m.id)).toEqual(["y", "x"]);
    const r = resolve(list, { y: { enabled: false } });
    expect(r.order.map((m) => m.id)).toEqual(["x"]);
    expect(r.disabled).toEqual(["y"]);
  });

  it("refuses a disabled dependency with the message and hint of 04 §4", () => {
    const err = failure(() =>
      resolve([mod("voice"), mod("screenshare", ["voice"])], { voice: { enabled: false } }),
    );
    expect(err.message).toBe(
      'Config error: module "screenshare" is enabled but its dependency "voice" is disabled.\n' +
        "  → enable modules.voice, or disable modules.screenshare",
    );
  });

  it("allows a module whose dependency is disabled to be disabled with it", () => {
    const r = resolve([mod("voice"), mod("screenshare", ["voice"])], {
      voice: { enabled: false },
      screenshare: { enabled: false },
    });
    expect(r.order).toEqual([]);
    expect(r.disabled.sort()).toEqual(["screenshare", "voice"]);
  });

  it("refuses to disable an always-on module", () => {
    const err = failure(() => resolve([mod("core", [], { alwaysOn: true })], { core: { enabled: false } }));
    expect(err.issues[0]?.message).toMatch(/"core" cannot be disabled/);
  });

  it("detects a cycle and names it", () => {
    const err = failure(() => resolve([mod("a", ["b"]), mod("b", ["c"]), mod("c", ["a"])]));
    expect(err.issues.map((i) => i.message).join("\n")).toMatch(/a → b → c → a|b → c → a → b|c → a → b → c/);
  });

  it("applies conflict rules: error refuses, warn only warns, a disabled side is fine", () => {
    const e2ee = mod("voice-e2ee", [], {
      conflictsWith: [
        { with: "recording", severity: "error", message: "recorded media would be undecodable." },
      ],
    });
    const recording = mod("recording");
    const err = failure(() => resolve([e2ee, recording]));
    expect(err.issues[0]?.message).toMatch(/"voice-e2ee" and "recording" cannot both be enabled/);
    expect(resolve([e2ee, recording], { recording: { enabled: false } }).warnings).toEqual([]);

    const warnOnly = mod("search", [], {
      conflictsWith: [{ with: "pg", severity: "warn", message: "falls back to LIKE." }],
    });
    expect(resolve([warnOnly, mod("pg")]).warnings).toEqual(['"search" with "pg": falls back to LIKE.']);
  });

  it("refuses a module whose port is not configured", () => {
    const err = failure(() => resolve([mod("voice", [], { requiresPorts: ["livekit"] })]));
    expect(err.issues[0]?.message).toMatch(/needs the "livekit" port/);
    expect(err.issues[0]?.hint).toMatch(/livekit:/);
  });

  it("rejects settings for a module that is not in the build, listing the ones that are", () => {
    const err = failure(() => resolve([mod("a")], { typo: { enabled: true } }));
    expect(err.issues[0]?.message).toBe("modules.typo is not a module in this build.");
    expect(err.issues[0]?.hint).toBe("available modules: a");
  });

  it("validates each enabled module's settings strictly and keeps the parsed values", () => {
    const schema = z.strictObject({ limit: z.number().int().default(5) });
    const m = mod("uploads", [], { configSchema: schema });
    expect(resolve([m]).configs.get("uploads")).toEqual({ limit: 5 });
    expect(resolve([m], { uploads: { enabled: true, limit: 9 } }).configs.get("uploads")).toEqual({
      limit: 9,
    });
    const err = failure(() => resolve([m], { uploads: { limit: "x", extra: 1 } }));
    expect(err.message).toMatch(/modules\.uploads\.limit/);
    expect(err.message).toMatch(/unknown setting "modules\.uploads\.extra"|extra/);
  });

  it("does not validate the settings of a disabled module", () => {
    const m = mod("uploads", [], { configSchema: z.strictObject({ limit: z.number() }) });
    expect(() => resolve([m], { uploads: { enabled: false, limit: "nonsense" } })).not.toThrow();
  });

  it("reports every problem at once", () => {
    const err = failure(() =>
      resolve([mod("a", ["missing"]), mod("b", [], { requiresPorts: ["livekit"] })], { zzz: {} }),
    );
    expect(err.issues.length).toBeGreaterThanOrEqual(3);
  });
});
