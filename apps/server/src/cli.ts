#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppError } from "@tincan/shared";
import { boot, createLogger } from "./boot.js";
import { cliSetup, configCheck, moduleList, userCreate } from "./cli/admin.js";
import { formatReport, runDoctor } from "./cli/doctor.js";
import { runInit } from "./cli/init.js";
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
  version

Common options:
  --config <file>         Configuration file (default: $TINCAN_CONFIG or ./config.yaml)

init:    --dir <dir> --domain <host> [--email <addr>] [--name <community>] [--http-port <n>] [--yes] [--force]
setup:   --username <name> [--display-name <name>] [--instance-name <name>] [--password-stdin]
user create: --username <name> [--display-name <name>] [--password-stdin]
doctor:  [--url <public url>]
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
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      username: { type: "string" },
      "display-name": { type: "string" },
      "instance-name": { type: "string" },
      "password-stdin": { type: "boolean" },
      url: { type: "string" },
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

    case "user": {
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
