// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSetupToken } from "../modules/accounts/setup-token.js";
import { ask, confirm } from "./prompt.js";
import { caddyfile, composeFile, configFile, envFile, livekitFile, type InitValues } from "./templates.js";

export interface InitOptions {
  dir: string;
  domain?: string;
  email?: string;
  name?: string;
  httpPort?: number;
  yes: boolean;
  force: boolean;
  insecureHttp?: boolean;
  /** Where the repository is, for `build:` entries; found automatically when running from a checkout. */
  repoDir?: string;
  image?: string;
}

const FILES = [".env", "config.yaml", "docker-compose.yml", "Caddyfile", "livekit.yaml"] as const;

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
  const repo = o.repoDir ?? findRepoRoot();
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
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    gid: typeof process.getgid === "function" ? process.getgid() : 1000,
    repoDir: repo ? (relative(outDir, repo) || ".").replace(/\\/g, "/") : null,
    image: o.image ?? "tincan",
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
  for (const f of FILES) say(`  ${f.padEnd(20)} ${describe(f)}`);
  say(`  data/setup-token     one-time token for creating the owner (also printed below)`);
  say(
    `Public URL: ${values.publicUrl}${values.insecureHttp ? "  (plain HTTP: for trying it out only)" : ""}`,
  );
  if (!values.repoDir)
    say(`Images: ${values.image}-server and ${values.image}-web must exist (no repository checkout found).`);
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
  const { token } = await ensureSetupToken(join(dir, "data"));

  say("");
  say("Done. Next:");
  say(`  1. cd ${dir} && docker compose up -d --build`);
  say(`  2. Open ${values.publicUrl}/setup and enter this setup token:`);
  say("");
  say(`       ${token}`);
  say("");
  say("     It is also saved in data/setup-token and removed once the owner exists.");
  say(`  3. Check the install any time with: tincan doctor --config ${join(dir, "config.yaml")}`);
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
      return "Caddy + app (+ LiveKit, not started yet)";
    case "Caddyfile":
      return "TLS, routes and security headers";
    case "livekit.yaml":
      return "LiveKit settings (voice arrives in a later milestone)";
  }
}
