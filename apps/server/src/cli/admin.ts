// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from "node:path";
import { hashPassword } from "@tincan/auth";
import { coreMigrations, type ModuleMigrations } from "@tincan/db";
import { AppError, UsernameSchema, DisplayNameSchema, checkPassword } from "@tincan/shared";
import { availablePorts, createPorts, describeBoot, formatBanner } from "../boot.js";
import type { CoreConfig } from "../config/schema.js";
import { resolveModules } from "../framework/loader.js";
import { ALL_MODULES } from "../modules/index.js";
import { accountsMigrations, type AccountsTables } from "../modules/accounts/schema.js";
import { deleteSetupToken } from "../modules/accounts/setup-token.js";
import { countUsers, createOwnerAndSpace, insertMember, insertUser } from "../modules/accounts/users.js";
import { askSecret, readStdin } from "./prompt.js";

/** `config check` (04 §9): validates the file and prints the module graph without starting anything. */
export function configCheck(config: CoreConfig): string {
  const graph = resolveModules({
    available: ALL_MODULES,
    rawModules: config.modules,
    ports: availablePorts(config),
  });
  return `${formatBanner(describeBoot(config, graph, null))}\n\nConfiguration is valid.`;
}

export function moduleList(config: CoreConfig): string {
  const graph = resolveModules({
    available: ALL_MODULES,
    rawModules: config.modules,
    ports: availablePorts(config),
  });
  const rows = [
    ...graph.order.map(
      (m) => `  on   ${m.id.padEnd(16)} ${m.version}   needs: ${m.dependsOn.join(", ") || "-"}`,
    ),
    ...graph.disabled.map((id) => `  off  ${id}`),
  ];
  return rows.join("\n");
}

async function readPassword(opts: { stdin: boolean }): Promise<string> {
  if (opts.stdin) return readStdin();
  const first = await askSecret("Password");
  if (first !== (await askSecret("Repeat password")))
    throw new AppError("VALIDATION_FAILED", "The passwords do not match.");
  return first;
}

async function withAccountsDb<T>(
  config: CoreConfig,
  fn: (db: ReturnType<typeof dbOf>) => Promise<T>,
): Promise<T> {
  const ports = await createPorts(config);
  try {
    const migrations: ModuleMigrations[] = [coreMigrations, accountsMigrations];
    await ports.db.migrate(migrations);
    return await fn(dbOf(ports.db));
  } finally {
    await ports.db.close();
  }
}
const dbOf = (db: Awaited<ReturnType<typeof createPorts>>["db"]) => db.as<AccountsTables>();

export interface UserArgs {
  username: string;
  displayName: string;
  passwordStdin: boolean;
}

/** `user create`: adds a member once the owner exists (11 §4). */
export async function userCreate(config: CoreConfig, args: UserArgs): Promise<string> {
  const username = UsernameSchema.parse(args.username);
  const displayName = DisplayNameSchema.parse(args.displayName || args.username);
  const password = await readPassword({ stdin: args.passwordStdin });
  const problem = checkPassword(password);
  if (problem) throw new AppError("VALIDATION_FAILED", `That password cannot be used (${problem}).`);
  const hash = await hashPassword(password);
  return withAccountsDb(config, async (db) => {
    if ((await countUsers(db)) === 0) {
      throw new AppError(
        "SETUP_REQUIRED",
        "There is no owner yet. Run `tincan setup`, or finish setup in the browser first.",
      );
    }
    await db.transaction(async (tx) => {
      const space = await tx.query.selectFrom("space").select("id").limit(1).executeTakeFirstOrThrow();
      const user = await insertUser(tx, { username, displayName, passwordHash: hash });
      await insertMember(tx, { spaceId: space.id, userId: user.id });
    });
    return `Created user ${username}.`;
  });
}

export interface SetupArgs extends UserArgs {
  instanceName: string;
}

/** `setup`: the CLI alternative to the browser flow (11 §1.4). Being on the host is the authorisation. */
export async function cliSetup(config: CoreConfig, args: SetupArgs): Promise<string> {
  const username = UsernameSchema.parse(args.username);
  const displayName = DisplayNameSchema.parse(args.displayName || args.username);
  const password = await readPassword({ stdin: args.passwordStdin });
  const problem = checkPassword(password);
  if (problem) throw new AppError("VALIDATION_FAILED", `That password cannot be used (${problem}).`);
  const hash = await hashPassword(password);
  return withAccountsDb(config, async (db) => {
    await db.transaction(async (tx) => {
      if ((await countUsers(tx)) > 0) throw new AppError("CONFLICT", "This server is already set up.");
      await createOwnerAndSpace(tx, {
        username,
        displayName,
        passwordHash: hash,
        instanceName: args.instanceName || config.instance.name,
      });
    });
    await deleteSetupToken(resolve(config.dataDir));
    return [
      `Created owner ${username}. The setup token was removed.`,
      "If the server is already running, restart it now so it notices and creates the default roles and channels:",
      "  docker compose restart tincan",
    ].join("\n");
  });
}
