// SPDX-License-Identifier: AGPL-3.0-or-later
import { AppError } from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";
import type { RolesApi } from "./api.js";
import { registerRoleRoutes } from "./routes.js";
import { rolesMigrations, type RolesTables } from "./schema.js";
import { RolesService, wire } from "./service.js";

/**
 * Roles, permissions and overwrites (11 §2). Always on: the platform has no meaning without it (04 §9).
 * Everything else asks this module through `RolesApi` instead of computing permissions itself.
 */
export default defineModule({
  id: "roles",
  version: VERSION,
  dependsOn: ["accounts"],
  requiresPorts: ["db"],
  alwaysOn: true,
  migrations: rolesMigrations,
  async register(ctx) {
    const accounts = ctx.api.get<AccountsApi>("accounts");
    if (!accounts) throw new AppError("INTERNAL", "roles: accounts did not provide its api");
    const db = ctx.ports.db.as<RolesTables>();
    const svc = new RolesService({
      db,
      accounts,
      gateway: ctx.gateway,
      events: ctx.events,
      log: ctx.log,
    });

    // Seed inside the transaction that creates the member, so setup and registration are atomic with it.
    accounts.onMemberJoin(async (tx, info) => {
      const t = tx.as<RolesTables>();
      if (info.isOwner) await svc.ensureDefaults(t, info.spaceId);
      await svc.grantOnJoin(t, info.spaceId, info.userId, info.defaultRoleId);
    });
    // An instance that was set up before this module existed (M1 data) gets its roles at boot.
    const spaceId = await accounts.spaceId();
    if (spaceId) await db.transaction((tx) => svc.ensureDefaults(tx, spaceId));

    accounts.setResetAuthorizer({
      async canReset(actorUserId, targetUserId) {
        const r = await svc.authorize(actorUserId, {
          kind: "member.reset-password",
          member: await svc.memberFacts(targetUserId),
        });
        return r.ok;
      },
    });

    ctx.gateway.provideChannelAccess((userId) => svc.accessFor(userId));
    ctx.gateway.contributeReady(async (actor) => ({
      permissions: String(await svc.basePermissions(actor.userId)),
      channelPermissions: await svc.channelPermissionMap(actor.userId),
      roles: (await svc.listRoles()).map(wire),
      members: await Promise.all((await accounts.listMembers()).map((m) => svc.memberDto(m))),
    }));

    accounts.onMemberJoined(async () => svc.markDirty());
    // A new member shows up in everyone's list.
    ctx.events.on("member.joined", async ({ userId }) => {
      const rec = await accounts.getMember(userId);
      if (rec) ctx.gateway.dispatchToAll("MEMBER_ADD", { member: await svc.memberDto(rec) });
    });

    registerRoleRoutes(ctx.http, svc, accounts);

    const api: RolesApi = {
      permissionsIn: (u, c) => svc.permissionsIn(u, c),
      basePermissions: (u) => svc.basePermissions(u),
      can: (u, p, c) => svc.can(u, p, c),
      assert: (u, p, c) => svc.assert(u, p, c),
      visibleChannelIds: (u) => svc.visibleChannelIds(u),
      channelPermissionMap: (u) => svc.channelPermissionMap(u),
      syncChannels: (c) => svc.syncChannels(c),
      onVisibilityChange: (fn) => svc.onVisibilityChange(fn),
      listRoles: () => svc.listRoles(),
      getRole: (id) => svc.getRole(id),
      roleIdsOf: (u) => svc.roleIdsOf(u),
      actorFacts: (u) => svc.actorFacts(u),
      memberFacts: (u) => svc.memberFacts(u),
      roleFacts: (r) => svc.roleFacts(r),
      authorize: (u, a) => svc.authorize(u, a),
      authorizeOrThrow: (u, a) => svc.authorizeOrThrow(u, a),
      listOverwrites: (c) => svc.listOverwrites(c),
      setOverwrite: (c, o) => svc.setOverwrite(c, o),
      deleteOverwrite: (c, t, id) => svc.deleteOverwrite(c, t, id),
      deleteChannelOverwrites: (tx, c) => svc.deleteChannelOverwrites(tx.as<RolesTables>(), c),
      setTimeout: (u, until) => svc.setTimeout(u, until),
      explain: (u, c) => svc.explain(u, c),
    };
    ctx.api.provide("roles", api);
    ctx.capabilities.feature("roles", true);
  },
});
