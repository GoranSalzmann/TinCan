// SPDX-License-Identifier: AGPL-3.0-or-later
import { AppError, namesOf, PERMISSION_NAMES } from "@tincan/shared";
import type { CoreConfig } from "../config/schema.js";
import type { AccountsApi } from "../modules/accounts/api.js";
import type { ChannelsApi } from "../modules/channels/api.js";
import type { RolesApi } from "../modules/roles/api.js";
import type { SearchApi } from "../modules/search/api.js";
import { withRuntime } from "./runtime.js";

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined)
    throw new AppError("FEATURE_DISABLED", `${what} is not enabled in this configuration.`);
  return v;
};

/** `search reindex` (18 T29): queue every live message for indexing and drop entries whose message is gone. */
export function searchReindex(
  config: CoreConfig,
  log: (line: string) => void = console.log,
): Promise<string> {
  return withRuntime(config, async (app) => {
    const search = need(app.apis.get<SearchApi>("search"), "The search module");
    const started = Date.now();
    const { queued, removed } = await search.reindex({
      onProgress: (n) => {
        if (n % 5000 === 0) log(`  queued ${n} messages …`);
      },
    });
    log(`Queued ${queued} messages, ${removed} stale entries. Waiting for the index to catch up …`);
    for (;;) {
      await app.outbox.drain();
      if ((await app.outbox.backlog()) === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return `Reindexed ${queued} messages in ${((Date.now() - started) / 1000).toFixed(1)} s; removed ${removed} stale entries.`;
  });
}

/** `perms explain` (11 §4): every step of the permission computation for one member in one channel. */
export function permsExplain(config: CoreConfig, args: { user: string; channel: string }): Promise<string> {
  return withRuntime(config, async (app) => {
    const accounts = need(app.apis.get<AccountsApi>("accounts"), "accounts");
    const roles = need(app.apis.get<RolesApi>("roles"), "roles");
    const channels = need(app.apis.get<ChannelsApi>("channels"), "channels");
    const userId = await accounts.userIdByUsername(args.user);
    if (!userId) throw new AppError("NOT_FOUND", `No user named "${args.user}".`);
    const found = (await channels.list()).find(
      (c) => c.id === args.channel || c.name.toLowerCase() === args.channel.toLowerCase(),
    );
    if (!found) throw new AppError("NOT_FOUND", `No channel "${args.channel}".`);
    const { permissions, steps } = await roles.explain(userId, found.id);
    const lines = [`${args.user} in #${found.name} (${found.type})`, ""];
    let prev = 0n;
    for (const s of steps) {
      const gained = namesOf(s.after & ~prev);
      const lost = namesOf(prev & ~s.after);
      lines.push(s.step);
      if (gained.length) lines.push(`    + ${gained.join(", ")}`);
      if (lost.length) lines.push(`    - ${lost.join(", ")}`);
      prev = s.after;
    }
    const allowed = namesOf(permissions);
    const denied = PERMISSION_NAMES.filter((n) => !allowed.includes(n));
    lines.push(
      "",
      `Allowed: ${allowed.join(", ") || "nothing"}`,
      `Denied:  ${denied.join(", ") || "nothing"}`,
    );
    return lines.join("\n");
  });
}

/** `user reset-password`: prints a one-time code (11 §1.6). `--owner` targets the owner account. */
export function resetPassword(
  config: CoreConfig,
  args: { username?: string; owner: boolean },
): Promise<string> {
  return withRuntime(config, async (app) => {
    const accounts = need(app.apis.get<AccountsApi>("accounts"), "accounts");
    const userId = args.owner
      ? await accounts.ownerId()
      : args.username
        ? await accounts.userIdByUsername(args.username)
        : null;
    if (!userId)
      throw new AppError(
        "NOT_FOUND",
        args.owner ? "There is no owner yet." : `No user named "${args.username}".`,
      );
    const { code, expiresAt } = await accounts.issueResetCode(userId);
    return `One-time reset code: ${code}\nValid until ${expiresAt.toISOString()}. Send it to the user, who enters it under "Use a reset code" on the login screen.`;
  });
}
