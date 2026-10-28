// SPDX-License-Identifier: AGPL-3.0-or-later
import { accessSync, constants, existsSync, statfsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { freemem, totalmem } from "node:os";
import { resolve } from "node:path";
import WebSocket from "ws";
import { CapabilitiesSchema, GATEWAY_PATH, GATEWAY_VERSION, Op } from "@tincan/shared";
import { availablePorts } from "../boot.js";
import type { CoreConfig } from "../config/schema.js";
import { resolveModules } from "../framework/loader.js";
import { ALL_MODULES } from "../modules/index.js";
import { VERSION } from "../version.js";

/** Glyphs of the design legend (docs/design/README.md): ok, failed, skipped. */
export type CheckStatus = "ok" | "fail" | "warn" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it (14 §9: "prints fixes"). */
  fix?: string;
}

const GLYPH: Record<CheckStatus, string> = { ok: "[ok]", fail: "[!!]", warn: "[! ]", skip: "[--]" };

export function formatReport(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${GLYPH[r.status]}  ${r.name.padEnd(34)} ${r.detail}`);
    if (r.fix && r.status !== "ok") lines.push(`      → ${r.fix}`);
  }
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  lines.push(
    "",
    failed
      ? `${failed} check(s) failed.`
      : warned
        ? `All required checks passed, ${warned} warning(s).`
        : "All checks passed.",
  );
  return lines.join("\n");
}

const MIN_FREE_BYTES = 1024 ** 3;

async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function check(name: string, fn: () => Promise<Omit<CheckResult, "name">>): Promise<CheckResult> {
  try {
    return { name, ...(await fn()) };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

/**
 * `tincan doctor` v0 (14 §9): configuration, disk, memory, database, then the public path
 * (DNS, HTTPS/proxy, capabilities, WebSocket). Network checks talk only to this instance's own URL.
 * Voice checks (UDP, TURN, LiveKit API, webhook round trip) arrive with the voice milestone.
 */
export async function runDoctor(config: CoreConfig, opts: { url?: string } = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const url = opts.url ?? config.instance.publicUrl;
  const dataDir = resolve(config.dataDir);

  results.push(
    await check("Configuration", async () => {
      const graph = resolveModules({
        available: ALL_MODULES,
        rawModules: config.modules,
        ports: availablePorts(config),
      });
      return { status: "ok", detail: `${graph.order.length} modules enabled` };
    }),
  );

  results.push(
    await check("Data directory writable", async () => {
      if (!existsSync(dataDir))
        return {
          status: "fail",
          detail: `${dataDir} does not exist`,
          fix: "create it, or run `tincan init`",
        };
      accessSync(dataDir, constants.W_OK);
      return { status: "ok", detail: dataDir };
    }),
  );

  results.push(
    await check("Disk space", async () => {
      const target = existsSync(dataDir) ? dataDir : resolve(".");
      const s = statfsSync(target);
      const free = Number(s.bavail) * Number(s.bsize);
      const gb = (free / 1024 ** 3).toFixed(1);
      return free < MIN_FREE_BYTES
        ? {
            status: "warn",
            detail: `${gb} GiB free`,
            fix: "free some disk space; messages, uploads and backups all grow",
          }
        : { status: "ok", detail: `${gb} GiB free` };
    }),
  );

  results.push(
    await check("Memory", async () => {
      const mib = Math.round(freemem() / 1024 ** 2);
      const total = Math.round(totalmem() / 1024 ** 2);
      return mib < 200
        ? {
            status: "warn",
            detail: `${mib} of ${total} MiB free`,
            fix: "the server and Caddy need a few hundred MiB; add swap or RAM",
          }
        : { status: "ok", detail: `${mib} of ${total} MiB free` };
    }),
  );

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    results.push({
      name: "Public URL",
      status: "fail",
      detail: `${url} is not a URL`,
      fix: "set instance.publicUrl",
    });
    return results;
  }

  results.push(
    await check("DNS", async () => {
      const addr = await within(5000, lookup(host));
      return { status: "ok", detail: `${host} → ${addr.address}` };
    }).then((r) =>
      r.status === "fail"
        ? { ...r, fix: `create an A/AAAA record for ${host} pointing at this machine (14 §4)` }
        : r,
    ),
  );

  let capsOk = false;
  results.push(
    await check("HTTPS and proxy", async () => {
      const started = Date.now();
      const res = await within(8000, fetch(`${url}/api/v1/capabilities`));
      if (!res.ok)
        return {
          status: "fail",
          detail: `HTTP ${res.status}`,
          fix: "is the app running? `docker compose logs tincan caddy`",
        };
      const parsed = CapabilitiesSchema.safeParse(await res.json());
      if (!parsed.success)
        return {
          status: "fail",
          detail: "the answer is not a Tin Can server",
          fix: "check the Caddyfile routes",
        };
      capsOk = true;
      const c = parsed.data;
      const when = res.headers.get("date");
      const skew = when ? Math.abs(Date.now() - new Date(when).getTime()) : 0;
      const parts = [`${c.server.name} ${c.server.version}`, `${Date.now() - started} ms`];
      if (c.auth.setupRequired) parts.push("setup not finished");
      return skew > 60_000
        ? {
            status: "warn",
            detail: parts.join(", "),
            fix: `this machine's clock differs from the server's by ${Math.round(skew / 1000)} s; enable time sync`,
          }
        : { status: "ok", detail: parts.join(", ") };
    }),
  );

  results.push(
    capsOk
      ? await check("Realtime connection (WebSocket)", async () => {
          const wsUrl = `${url.replace(/^http/, "ws")}${GATEWAY_PATH}?v=${GATEWAY_VERSION}&encoding=json`;
          const hello = await within(
            8000,
            new Promise<{ op: number }>((resolveHello, reject) => {
              const ws = new WebSocket(wsUrl, { headers: { origin: new URL(url).origin } });
              ws.once("message", (data) => {
                ws.close();
                resolveHello(JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as { op: number });
              });
              ws.once("error", reject);
            }),
          );
          return hello.op === Op.HELLO
            ? { status: "ok", detail: "HELLO received" }
            : { status: "fail", detail: `unexpected frame ${hello.op}` };
        }).then((r) =>
          r.status === "fail"
            ? { ...r, fix: "Caddy must proxy /gateway with WebSocket upgrade; check the Caddyfile" }
            : r,
        )
      : {
          name: "Realtime connection (WebSocket)",
          status: "skip",
          detail: "needs the HTTPS check to pass first",
        },
  );

  for (const name of [
    "Voice server reachable",
    "Voice media port (UDP 7882)",
    "Relay (TURN/TLS 5349)",
    "Public IP matches",
  ]) {
    results.push({ name, status: "skip", detail: "arrives with voice (milestone 3)" });
  }
  return results;
}

export const doctorVersion = VERSION;
