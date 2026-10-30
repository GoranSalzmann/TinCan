// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "@tincan/db";
import { Op, CapabilitiesSchema } from "@tincan/shared";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../config/errors.js";
import { ALL_MODULES } from "../modules/index.js";
import { startTestServer, type TestServer } from "../testing/harness.js";
import { defineModule, type AnyManifest, type ConflictRule, type PortName } from "./types.js";

/**
 * Module boot matrix (04 §11, 16 §4). It runs over the modules this build ships plus stand-ins for
 * the rest of the v1 inventory of 04 §2, so the loader is exercised against the real dependency
 * graph before those modules exist. A stand-in registers one route, one feature flag, one table, and
 * (voice, text-chat) the gateway command that 07 §4.6 assigns to it. When a real module lands it
 * replaces its stand-in here by id.
 */

interface Spec {
  id: string;
  dependsOn: string[];
  ports?: PortName[];
  alwaysOn?: boolean;
  command?: string;
  conflictsWith?: ConflictRule[];
}

const INVENTORY: Spec[] = [
  { id: "roles", dependsOn: ["accounts"], alwaysOn: true },
  { id: "channels", dependsOn: ["roles"], alwaysOn: true },
  { id: "invites", dependsOn: ["accounts"] },
  { id: "text-chat", dependsOn: ["channels"], command: "typing.start" },
  { id: "read-state", dependsOn: ["text-chat"] },
  { id: "uploads", dependsOn: ["accounts"], ports: ["storage"] },
  { id: "reactions", dependsOn: ["text-chat"] },
  { id: "search", dependsOn: ["text-chat"] },
  { id: "link-previews", dependsOn: ["text-chat", "uploads"] },
  { id: "voice", dependsOn: ["channels", "roles"], ports: ["livekit"], command: "voice.state" },
  { id: "video", dependsOn: ["voice"], ports: ["livekit"] },
  { id: "screenshare", dependsOn: ["voice"], ports: ["livekit"] },
  {
    id: "voice-e2ee",
    dependsOn: ["voice"],
    conflictsWith: [
      {
        with: "recording",
        severity: "error",
        message: "recorded media would be undecodable or E2EE would be bypassed.",
      },
    ],
  },
  { id: "recording", dependsOn: ["voice"], ports: ["livekit", "storage"] },
  { id: "moderation", dependsOn: ["roles"] },
  { id: "metrics", dependsOn: ["core"] },
];

function standIn(spec: Spec): AnyManifest {
  return defineModule({
    id: spec.id,
    version: "0.0.0",
    dependsOn: spec.dependsOn,
    requiresPorts: spec.ports ?? [],
    ...(spec.alwaysOn ? { alwaysOn: true } : {}),
    ...(spec.conflictsWith ? { conflictsWith: spec.conflictsWith } : {}),
    migrations: {
      module: spec.id,
      tables: [`t_${spec.id.replace(/-/g, "_")}`],
      migrations: [
        {
          version: 1,
          name: "table",
          up: async (db) => {
            await db.schema
              .createTable(`t_${spec.id.replace(/-/g, "_")}`)
              .addColumn("id", "text", (c) => c.primaryKey())
              .execute();
          },
        },
      ],
    },
    register(ctx) {
      ctx.http.get(`/probe/${spec.id}`, () => ({ id: spec.id }));
      ctx.capabilities.feature(spec.id, true);
      if (spec.command) ctx.gateway.onCommand(spec.command, () => undefined);
    },
  });
}

const real = new Map(ALL_MODULES.map((m) => [m.id, m]));
const ALL: AnyManifest[] = [...ALL_MODULES, ...INVENTORY.filter((s) => !real.has(s.id)).map(standIn)];
const byId = new Map(ALL.map((m) => [m.id, m]));
const alwaysOn = new Set(ALL.filter((m) => m.alwaysOn).map((m) => m.id));
const optional = ALL.filter((m) => !m.alwaysOn).map((m) => m.id);
const livekit = { url: "wss://chat.example.com/livekit", apiKey: "key", apiSecret: "secret" };

function closure(ids: string[]): Set<string> {
  const out = new Set<string>();
  const visit = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
  };
  for (const id of [...alwaysOn, ...ids]) visit(id);
  return out;
}

function dependents(id: string): Set<string> {
  const out = new Set<string>([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const m of ALL) {
      if (!out.has(m.id) && m.dependsOn.some((d) => out.has(d))) {
        out.add(m.id);
        grew = true;
      }
    }
  }
  return out;
}

/** modules: config that enables exactly `enabled` and disables every other optional module. */
function configFor(enabled: Set<string>) {
  const modules: Record<string, unknown> = {
    accounts: { argon2: { memoryKiB: 1024, timeCost: 1, parallelism: 1 } },
  };
  for (const id of optional) if (!enabled.has(id)) modules[id] = { enabled: false };
  return { livekit, modules };
}

async function expectConsistent(s: TestServer, enabled: Set<string>) {
  const db = s.running.ports.db;
  const token = await s.setupOwner(); // routes answer SETUP_REQUIRED until an owner exists

  // /capabilities has the documented shape and lists exactly the enabled features
  const caps = await s.request("GET", "/api/v1/capabilities");
  expect(CapabilitiesSchema.safeParse(caps.body).success).toBe(true);
  const stand = ALL.filter((m) => !real.has(m.id));
  // Every enabled module except core and accounts announces itself as a feature.
  const expectedFeatures = ALL.filter((m) => enabled.has(m.id) && m.id !== "core" && m.id !== "accounts")
    .map((m) => m.id)
    .sort();
  expect(Object.keys(caps.body.features).sort()).toEqual(expectedFeatures);

  // routes exist for enabled modules only
  for (const m of stand) {
    const res = await s.request("GET", `/api/v1/probe/${m.id}`);
    expect(res.status, `probe ${m.id}`).toBe(enabled.has(m.id) ? 200 : 404);
  }

  // migrations created the tables of enabled modules and nothing else
  const tables = (
    await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`.execute(db.query)
  ).rows.map((r) => r.name);
  const expectedTables = new Set(["_migrations"]);
  for (const m of ALL)
    if (enabled.has(m.id)) for (const t of m.migrations?.tables ?? []) expectedTables.add(t);
  expect([...tables].sort()).toEqual([...expectedTables].sort());

  // the gateway answers FEATURE_DISABLED for a command whose module is off, and runs it when it is on
  const sock = s.connect();
  await sock.next();
  sock.send({ op: Op.IDENTIFY, d: { token, client: { name: "m", version: "1", platform: "node" } } });
  await sock.next((f) => f.t === "READY");
  for (const [cmd, owner] of [
    ["typing.start", "text-chat"],
    ["voice.state", "voice"],
  ] as const) {
    sock.send({ op: Op.COMMAND, d: { cmd, args: {}, id: cmd } });
    const res = (await sock.next((f) => f.op === Op.COMMAND_RESULT && (f.d as { id: string }).id === cmd))
      .d as {
      ok: boolean;
      error?: { code: string };
    };
    // A real module may reject the empty args this probe sends; what matters is that it ran.
    if (enabled.has(owner)) expect(res.error?.code ?? "ok", cmd).not.toBe("FEATURE_DISABLED");
    else expect(res.error?.code, cmd).toBe("FEATURE_DISABLED");
  }
  sock.close();
}

describe("module boot matrix", () => {
  it("knows the whole v1 inventory of 04 §2", () => {
    expect(ALL.map((m) => m.id).sort()).toEqual(
      [
        "core",
        "accounts",
        "roles",
        "channels",
        "invites",
        "text-chat",
        "read-state",
        "uploads",
        "reactions",
        "search",
        "link-previews",
        "voice",
        "video",
        "screenshare",
        "voice-e2ee",
        "recording",
        "moderation",
        "metrics",
      ].sort(),
    );
  });

  it("boots the full set", async () => {
    const s = await startTestServer({
      modules: ALL,
      config: configFor(new Set(optional.filter((id) => id !== "recording"))),
    });
    try {
      // voice-e2ee and recording conflict (04 §5), so "full" means everything except recording
      await expectConsistent(s, new Set(ALL.map((m) => m.id).filter((id) => id !== "recording")));
    } finally {
      await s.close();
    }
  });

  it.each(optional)("boots with %s alone (plus its dependencies)", async (id) => {
    const enabled = closure([id]);
    const s = await startTestServer({ modules: ALL, config: configFor(enabled) });
    try {
      await expectConsistent(s, enabled);
    } finally {
      await s.close();
    }
  });

  it.each(optional)(
    "boots with %s and everything that depends on it removed from the full set",
    async (id) => {
      const gone = dependents(id);
      const enabled = new Set(ALL.map((m) => m.id).filter((m) => !gone.has(m) && m !== "recording"));
      const s = await startTestServer({ modules: ALL, config: configFor(enabled) });
      try {
        await expectConsistent(s, enabled);
      } finally {
        await s.close();
      }
    },
  );

  it("refuses to boot when only a dependency is removed, naming the fix", async () => {
    await expect(
      startTestServer({ modules: ALL, config: { livekit, modules: { voice: { enabled: false } } } }),
    ).rejects.toThrow(
      /module "video" is enabled but its dependency "voice" is disabled\.\n {2}→ enable modules\.voice, or disable modules\.video/,
    );
  });

  it("refuses voice-e2ee together with recording", async () => {
    const err = await startTestServer({ modules: ALL, config: { livekit } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toMatch(/"voice-e2ee" and "recording" cannot both be enabled/);
  });

  it("refuses a module whose port is not configured", async () => {
    await expect(
      startTestServer({
        modules: ALL,
        config: { modules: { "voice-e2ee": { enabled: false }, recording: { enabled: false } } },
      }),
    ).rejects.toThrow(/needs the "livekit" port/);
  });

  it("refuses settings for a module this build does not have, and stray settings", async () => {
    await expect(startTestServer({ config: { modules: { reactions: { enabled: true } } } })).rejects.toThrow(
      /modules\.reactions is not a module in this build/,
    );
    await expect(startTestServer({ config: { modules: { accounts: { signupp: "open" } } } })).rejects.toThrow(
      /unknown setting "modules\.accounts\.signupp"/,
    );
  });

  it("cannot disable an always-on module", async () => {
    await expect(startTestServer({ config: { modules: { accounts: { enabled: false } } } })).rejects.toThrow(
      /"accounts" cannot be disabled/,
    );
  });
});
