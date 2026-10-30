// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSetupToken } from "../modules/accounts/setup-token.js";
import { ask, confirm } from "./prompt.js";
import {
  alertRules,
  grafanaDashboard,
  grafanaDatasource,
  grafanaProvider,
  prometheusConfig,
} from "./monitoring.js";
import { caddyfile, composeFile, configFile, envFile, livekitFile, type InitValues } from "./templates.js";
import { insideContainer, prerequisiteFindings, realProbe } from "./prereqs.js";
import { VERSION } from "../version.js";

export interface InitOptions {
  dir: string;
  domain?: string;
  email?: string;
  name?: string;
  httpPort?: number;
  /** DNS name for TURN/TLS (a second name pointing at this machine); TURN stays off without it. */
  turnDomain?: string;
  /** Docker host gateway address, when `docker0` is not 172.17.0.1. */
  hostGatewayIp?: string;
  yes: boolean;
  force: boolean;
  insecureHttp?: boolean;
  /** Where the repository is, for `build:` entries; found automatically when running from a checkout. */
  repoDir?: string;
  /** Use released images (`<image>-server:<version>`, `<image>-web:<version>`) instead of building from a checkout. */
  image?: string;
  /** Release tag for `image`; defaults to the version of this program. */
  version?: string;
  /** The folder as the person sees it, when `dir` is a mount inside a container (`TINCAN_INIT_HOST_DIR`). */
  hostDir?: string;
}

const IMAGE_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const FILES = [
  ".env",
  "config.yaml",
  "docker-compose.yml",
  "Caddyfile",
  "livekit.yaml",
  "monitoring/prometheus.yml",
] as const;

function findRepoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "deploy", "Dockerfile"))) return dir;
    dir = dirname(dir);
  }
  return null;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export function buildValues(
  o: Required<Pick<InitOptions, "domain">> & InitOptions,
  outDir: string,
): InitValues {
  const insecureHttp = o.insecureHttp ?? /^localhost(:\d+)?$/.test(o.domain);
  const domain = o.domain.replace(/:\d+$/, "");
  const httpPort = o.httpPort ?? 8080;
  if (o.version && !o.image)
    throw new Error(
      "--version goes with --image, for example: --image ghcr.io/goransalzmann/tincan --version 0.2.0",
    );
  if (o.image && !IMAGE_NAME.test(o.image))
    throw new Error(
      `"${o.image}" is not an image name. Use lower case without a tag, for example ghcr.io/goransalzmann/tincan (the -server and -web parts and the version are added).`,
    );
  const imageTag = o.image ? (o.version ?? VERSION).replace(/^v(?=\d)/, "") : null;
  if (imageTag !== null && !IMAGE_TAG.test(imageTag))
    throw new Error(`"${imageTag}" is not a valid version tag. Use for example 0.2.0 or 0.2.0-beta.1.`);
  // Released images and a checkout are alternatives: --image wins, so a checkout can still try a published release.
  const repo = o.image ? null : (o.repoDir ?? findRepoRoot());
  if (!o.image && !repo)
    throw new Error(
      "No Tin Can checkout was found here, so there is nothing to build the images from. Use released images instead: " +
        "tincan init --image ghcr.io/goransalzmann/tincan --version <release> (docs/guides/hosting.md).",
    );
  return {
    domain,
    acmeEmail: o.email ?? "",
    instanceName: o.name ?? "Tin Can",
    insecureHttp,
    httpPort,
    publicUrl: insecureHttp ? `http://${domain}:${httpPort}` : `https://${domain}`,
    instanceSecret: hex(32),
    livekitKey: `API${hex(6)}`,
    livekitSecret: hex(24),
    metricsToken: hex(24),
    grafanaPassword: hex(12),
    turnDomain: insecureHttp ? null : (o.turnDomain ?? null),
    hostGatewayIp: o.hostGatewayIp ?? "172.17.0.1",
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    gid: typeof process.getgid === "function" ? process.getgid() : 1000,
    repoDir: repo ? (relative(outDir, repo) || ".").replace(/\\/g, "/") : null,
    image: o.image ?? "tincan",
    imageTag,
  };
}

/** `tincan init` (14 §4): says what it will do, then writes config, secrets, compose, Caddyfile and the setup token. */
export async function runInit(opts: InitOptions): Promise<string[]> {
  const out: string[] = [];
  const say = (s: string) => out.push(s);
  const dir = resolve(opts.dir);

  const domain =
    opts.domain ??
    (opts.yes
      ? ""
      : await ask("Domain name for this server (or `localhost` for a local trial)", "localhost"));
  if (!domain)
    throw new Error("A domain is required: tincan init --domain chat.example.com (or --domain localhost)");
  const email =
    opts.email ??
    (opts.yes || /^localhost/.test(domain) ? "" : await ask("Email for certificate notices (optional)", ""));
  const name = opts.name ?? (opts.yes ? "Tin Can" : await ask("Name of your community", "Tin Can"));
  const values = buildValues({ ...opts, domain, email, name }, dir);

  const existing = FILES.filter((f) => existsSync(join(dir, f)));
  if (existing.length > 0 && !opts.force) {
    throw new Error(
      `Refusing to overwrite ${existing.join(", ")} in ${dir}. Re-run with --force to replace them (secrets would change), or pick another --dir.`,
    );
  }

  say(`Tin Can init will write to ${dir}:`);
  for (const f of FILES) say(`  ${f.padEnd(26)} ${describe(f)}`);
  say(`  data/setup-token           one-time token for creating the owner (also printed below)`);
  say(
    `Public URL: ${values.publicUrl}${values.insecureHttp ? "  (plain HTTP: for trying it out only)" : ""}`,
  );
  if (values.imageTag)
    say(
      `Images: ${values.image}-server:${values.imageTag} and ${values.image}-web:${values.imageTag} (pulled by docker compose)`,
    );
  for (const f of prerequisiteFindings(realProbe(), insideContainer())) say(`! ${f}`);
  console.log(out.join("\n"));
  out.length = 0;

  if (!opts.yes && !(await confirm("Go ahead?"))) throw new Error("Cancelled. Nothing was written.");

  await mkdir(join(dir, "data"), { recursive: true });
  const write = async (file: string, content: string, mode?: number) => {
    await writeFile(join(dir, file), content, mode ? { mode } : undefined);
    if (mode && process.platform !== "win32") await chmod(join(dir, file), mode);
  };
  await write(".env", envFile(values), 0o600);
  await write("config.yaml", configFile(values));
  await write("docker-compose.yml", composeFile(values));
  await write("Caddyfile", caddyfile(values));
  await write("livekit.yaml", livekitFile(values), 0o600);
  // The dashboards profile (14 §8). Its data directories exist before Docker can create them as root.
  for (const d of [
    "monitoring/grafana/provisioning/datasources",
    "monitoring/grafana/provisioning/dashboards",
    "monitoring/grafana/dashboards",
    "monitoring/prometheus-data",
    "monitoring/grafana-data",
  ])
    await mkdir(join(dir, d), { recursive: true });
  await write("monitoring/prometheus.yml", prometheusConfig());
  await write("monitoring/alerts.yml", alertRules());
  await write("monitoring/metrics-token", values.metricsToken, 0o600);
  await write("monitoring/grafana/provisioning/datasources/prometheus.yml", grafanaDatasource());
  await write("monitoring/grafana/provisioning/dashboards/tincan.yml", grafanaProvider());
  await write("monitoring/grafana/dashboards/tincan.json", grafanaDashboard());
  const { token } = await ensureSetupToken(join(dir, "data"));

  say("");
  say("Done. Next:");
  const shown = opts.hostDir ?? dir;
  say(`  1. cd ${shown} && docker compose ${values.imageTag ? "up -d" : "up -d --build"}`);
  say(
    `     (voice: add --profile voice; it needs ports 7881/tcp and 7882/udp open, see docs/guides/hosting.md)`,
  );
  say(`  2. Open ${values.publicUrl}/setup and enter this setup token:`);
  say("");
  say(`       ${token}`);
  say("");
  say("     It is also saved in data/setup-token and removed once the owner exists.");
  say(
    values.imageTag
      ? `  3. Check the install any time with: docker compose exec tincan node dist/cli.js doctor`
      : `  3. Check the install any time with: tincan doctor --config ${join(shown, "config.yaml")}`,
  );
  if (!values.insecureHttp)
    say(`  DNS: point ${values.domain} at this machine first; ports 80 and 443 must be reachable (14 §3).`);
  return out;
}

function describe(f: (typeof FILES)[number]): string {
  switch (f) {
    case ".env":
      return "secrets (mode 0600)";
    case "config.yaml":
      return "settings";
    case "docker-compose.yml":
      return "Caddy + app + LiveKit (voice; start with --profile voice)";
    case "Caddyfile":
      return "TLS, routes and security headers";
    case "livekit.yaml":
      return "LiveKit settings (ports, webhook, TURN)";
    case "monitoring/prometheus.yml":
      return "metrics and dashboards (monitoring/, start with --profile dashboards)";
  }
}
