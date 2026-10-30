#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppError } from "@tincan/shared";
import { boot, createLogger } from "./boot.js";
import { cliSetup, configCheck, moduleList, userCreate } from "./cli/admin.js";
import { formatReport, runDoctor } from "./cli/doctor.js";
import { createBackup, restoreBackup } from "./cli/backup.js";
import { e2eeRotateSecret, permsExplain, resetPassword, searchReindex } from "./cli/ops.js";
import { runInit } from "./cli/init.js";
import { turnReloadReport } from "./cli/voice-checks.js";
import { ConfigError } from "./config/errors.js";
import { loadConfig } from "./config/load.js";
import { VERSION } from "./version.js";

const USAGE = `Tin Can ${VERSION}

Usage: tincan [admin] <command> [options]

  serve                   Start the server (default)
  init                    Generate config, secrets, compose files and the setup token
  doctor                  Check this installation (config, disk, DNS, HTTPS, WebSocket)
  config check            Validate the configuration and print the module graph
  module list             Show enabled and disabled modules
  setup                   Create the owner from the command line (instead of the browser)
  user create             Add a member (the owner must exist)
  user reset-password     Print a one-time password-reset code for a user (or --owner)
  search reindex          Rebuild the search index from the messages, online
  voice turn-reload       Restart LiveKit for a renewed TURN certificate when no call is running
  backup                  Write a consistent backup (database, uploads, config) as one .tar.gz
  restore <archive>       Unpack a backup into a new, empty directory and verify it
  e2ee rotate-secret      Give every encrypted voice call a new key from a fresh salt
  perms explain           Show how a member's permissions in a channel come about
  version

Common options:
  --config <file>         Configuration file (default: $TINCAN_CONFIG or ./config.yaml)

init:    --dir <dir> --domain <host> [--email <addr>] [--name <community>] [--http-port <n>] [--turn-domain <name>] [--host-gateway-ip <ip>] [--yes] [--force]
setup:   --username <name> [--display-name <name>] [--instance-name <name>] [--password-stdin]
user create: --username <name> [--display-name <name>] [--password-stdin]
user reset-password: --username <name> | --owner
perms explain: --user <username> --channel <name or id>
backup:  [--out <dir>] [--include-secrets] [--keep <n>]    (the archive is only as private as the secrets in it)
restore: <archive> --into <empty dir>
doctor:  [--url <public url>] [--turn-domain <name>]
voice turn-reload: --turn-domain <name> [--apply]
`;

function configPath(given: string | undefined): string | undefined {
  const path = given ?? process.env.TINCAN_CONFIG ?? (existsSync("config.yaml") ? "config.yaml" : undefined);
  return path;
}

async function main(argv: string[]): Promise<number> {
  const args = argv[0] === "admin" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      dir: { type: "string" },
      domain: { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
      "http-port": { type: "string" },
      "turn-domain": { type: "string" },
      "host-gateway-ip": { type: "string" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      apply: { type: "boolean" },
      username: { type: "string" },
      "display-name": { type: "string" },
      "instance-name": { type: "string" },
      "password-stdin": { type: "boolean" },
      url: { type: "string" },
      owner: { type: "boolean" },
      out: { type: "string" },
      into: { type: "string" },
      keep: { type: "string" },
      "include-secrets": { type: "boolean" },
      user: { type: "string" },
      channel: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd = "serve", sub] = positionals;
  if (values.help || cmd === "help") {
    console.log(USAGE);
    return 0;
  }

  switch (cmd) {
    case "version":
      console.log(VERSION);
      return 0;

    case "init": {
      const lines = await runInit({
        dir: values.dir ?? ".",
        yes: values.yes ?? false,
        force: values.force ?? false,
        ...(values.domain ? { domain: values.domain } : {}),
        ...(values.email ? { email: values.email } : {}),
        ...(values.name ? { name: values.name } : {}),
        ...(values["http-port"] ? { httpPort: Number(values["http-port"]) } : {}),
        ...(values["turn-domain"] ? { turnDomain: values["turn-domain"] } : {}),
        ...(values["host-gateway-ip"] ? { hostGatewayIp: values["host-gateway-ip"] } : {}),
      });
      console.log(lines.join("\n"));
      return 0;
    }

    case "serve": {
      const config = loadConfig(configPath(values.config));
      const running = await boot({ config, logger: createLogger(config) });
      console.log(running.banner);
      const stop = (signal: string) => {
        console.log(`${signal} received, shutting down`);
        const force = setTimeout(() => process.exit(1), 15_000); // SIGTERM timeout (05 §1)
        force.unref();
        void running.close().then(() => process.exit(0));
      };
      process.once("SIGTERM", () => stop("SIGTERM"));
      process.once("SIGINT", () => stop("SIGINT"));
      return -1; // keep running
    }

    case "config": {
      if (sub !== "check") throw new Error("Usage: tincan config check");
      console.log(configCheck(loadConfig(configPath(values.config))));
      return 0;
    }

    case "module": {
      if (sub !== "list") throw new Error("Usage: tincan module list");
      console.log(moduleList(loadConfig(configPath(values.config))));
      return 0;
    }

    case "doctor": {
      const config = loadConfig(configPath(values.config));
      const path = configPath(values.config);
      const results = await runDoctor(config, {
        ...(values.url ? { url: values.url } : {}),
        ...(values["turn-domain"] ? { turnDomain: values["turn-domain"] } : {}),
        ...(path ? { configDir: dirname(resolve(path)) } : {}),
      });
      console.log(formatReport(results));
      return results.some((r) => r.status === "fail") ? 1 : 0;
    }

    case "setup": {
      if (!values.username)
        throw new Error("Usage: tincan setup --username <name> [--display-name <name>] [--password-stdin]");
      console.log(
        await cliSetup(loadConfig(configPath(values.config)), {
          username: values.username,
          displayName: values["display-name"] ?? "",
          instanceName: values["instance-name"] ?? "",
          passwordStdin: values["password-stdin"] ?? false,
        }),
      );
      return 0;
    }

    case "voice": {
      if (sub !== "turn-reload")
        throw new Error("usage: tincan voice turn-reload --turn-domain <name> [--apply]");
      const domain = values["turn-domain"] ?? process.env.TURN_DOMAIN;
      if (!domain) throw new Error("--turn-domain <name> is required");
      const config = loadConfig(configPath(values.config));
      const report = await turnReloadReport(config, domain);
      console.log(report.lines.join("\n"));
      if (report.decision === "restart") {
        if (!values.apply) {
          console.log("Run again with --apply to restart LiveKit now (this drops any call in progress).");
        } else {
          const path = configPath(values.config);
          const r = spawnSync("docker", ["compose", "restart", "livekit"], {
            cwd: path ? dirname(resolve(path)) : ".",
            stdio: "inherit",
          });
          return r.status ?? 1;
        }
      }
      return 0;
    }

    case "backup": {
      const path = configPath(values.config);
      const config = loadConfig(path);
      const keep = values.keep === undefined ? undefined : Number(values.keep);
      if (keep !== undefined && (!Number.isInteger(keep) || keep < 1))
        throw new Error("--keep needs a whole number of 1 or more");
      const { path: file, manifest } = await createBackup(config, {
        ...(values.out ? { outDir: values.out } : {}),
        ...(path ? { configDir: dirname(resolve(path)) } : {}),
        includeSecrets: values["include-secrets"] ?? false,
        ...(keep !== undefined ? { keep } : {}),
        log: (l) => console.log(l),
      });
      console.log(
        `
Backup written: ${file}
${manifest.entries.length} entries, ${
          manifest.secretsIncluded
            ? "WITH secrets: keep it as private as the server itself"
            : "without secrets (.env is not included)"
        }.`,
      );
      return 0;
    }

    case "restore": {
      const archive = sub;
      if (!archive || !values.into)
        throw new Error("Usage: tincan restore <archive> --into <empty directory>");
      const r = await restoreBackup(archive, values.into, { log: (l) => console.log(l) });
      console.log(`
Restored ${r.files} file(s) and the database into ${r.into}`);
      for (const w of r.warnings) console.log(`  ! ${w}`);
      console.log(`Next: cd ${r.into} && docker compose up -d`);
      return 0;
    }

    case "e2ee": {
      if (sub !== "rotate-secret") throw new Error("Usage: tincan e2ee rotate-secret");
      console.log(await e2eeRotateSecret(loadConfig(configPath(values.config))));
      return 0;
    }

    case "search": {
      if (sub !== "reindex") throw new Error("Usage: tincan search reindex");
      console.log(await searchReindex(loadConfig(configPath(values.config))));
      return 0;
    }

    case "perms": {
      if (sub !== "explain" || !values.user || !values.channel)
        throw new Error("Usage: tincan perms explain --user <username> --channel <name or id>");
      console.log(
        await permsExplain(loadConfig(configPath(values.config)), {
          user: values.user,
          channel: values.channel,
        }),
      );
      return 0;
    }

    case "user": {
      if (sub === "reset-password") {
        if (!values.owner && !values.username)
          throw new Error("Usage: tincan user reset-password --username <name> | --owner");
        console.log(
          await resetPassword(loadConfig(configPath(values.config)), {
            ...(values.username ? { username: values.username } : {}),
            owner: values.owner ?? false,
          }),
        );
        return 0;
      }
      if (sub !== "create" || !values.username)
        throw new Error(
          "Usage: tincan user create --username <name> [--display-name <name>] [--password-stdin]",
        );
      console.log(
        await userCreate(loadConfig(configPath(values.config)), {
          username: values.username,
          displayName: values["display-name"] ?? "",
          passwordStdin: values["password-stdin"] ?? false,
        }),
      );
      return 0;
    }

    default:
      console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    if (err instanceof ConfigError) console.error(err.message);
    else if (err instanceof AppError) console.error(err.message);
    else console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
