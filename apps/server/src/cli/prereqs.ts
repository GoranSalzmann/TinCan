// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** What `tincan init` looks for before it writes anything. Findings are advice: init still writes the files. */
export interface Probe {
  /** Trimmed stdout when the command ran and exited 0; null when it is missing or failed, with stderr for the message. */
  (cmd: string, args: string[]): { out: string; err: string } | null;
}

const MIN_ENGINE = [20, 10] as const; // `host-gateway` in extra_hosts
const MIN_COMPOSE_MAJOR = 2;

export function parseVersion(text: string): number[] | null {
  const m = /v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

const atLeast = (v: number[], min: readonly number[]) =>
  v[0]! > min[0]! || (v[0] === min[0] && v[1]! >= min[1]!);

/** Pure so it can be tested: turns probe results into plain sentences. */
export function prerequisiteFindings(probe: Probe, insideContainer: boolean): string[] {
  const out: string[] = [];
  const engine = probe("docker", ["version", "--format", "{{.Server.Version}}"]);
  const compose = probe("docker", ["compose", "version", "--short"]);
  const cli = probe("docker", ["--version"]);
  if (!cli) {
    if (!insideContainer)
      out.push(
        "Docker was not found on this machine. That is fine if you will copy this folder to the server, " +
          "but the server needs Docker Engine 20.10 or newer and Docker Compose v2 (https://docs.docker.com/engine/install/).",
      );
    return out;
  }
  if (!engine) {
    out.push(
      "Docker is installed but its server did not answer. Start Docker, and on Linux either run as root or add " +
        "your user to the `docker` group (then log in again).",
    );
  } else {
    const v = parseVersion(engine.out);
    if (v && !atLeast(v, MIN_ENGINE))
      out.push(`Docker Engine ${engine.out} is older than 20.10, which this setup needs. Update Docker.`);
  }
  if (!compose) {
    out.push(
      "`docker compose` (Compose v2) was not found. `docker-compose` (v1) is not supported: install the Compose plugin " +
        "(https://docs.docker.com/compose/install/).",
    );
  } else {
    const v = parseVersion(compose.out);
    if (v && v[0]! < MIN_COMPOSE_MAJOR)
      out.push(`Docker Compose ${compose.out} is too old: Compose v2 or newer is needed.`);
  }
  return out;
}

export function realProbe(): Probe {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
    if (r.error || r.status !== 0) return null;
    return { out: r.stdout.trim(), err: r.stderr.trim() };
  };
}

export const insideContainer = () => existsSync("/.dockerenv");
