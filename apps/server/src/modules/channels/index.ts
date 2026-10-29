// SPDX-License-Identifier: AGPL-3.0-or-later
import { AppError } from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";
import type { RolesApi } from "../roles/api.js";
import type { ChannelsApi } from "./api.js";
import { registerChannelRoutes } from "./routes.js";
import { channelsMigrations, type ChannelsTables } from "./schema.js";
import { ChannelsService, channelWire } from "./service.js";

/** Categories and channels (06 §3.4). Always on; visibility comes from `roles`. */
export default defineModule({
  id: "channels",
  version: VERSION,
  dependsOn: ["roles"],
  requiresPorts: ["db"],
  alwaysOn: true,
  migrations: channelsMigrations,
  async register(ctx) {
    const roles = ctx.api.get<RolesApi>("roles");
    const accounts = ctx.api.get<AccountsApi>("accounts");
    if (!roles || !accounts) throw new AppError("INTERNAL", "channels: roles or accounts is missing");
    const db = ctx.ports.db.as<ChannelsTables>();
    const svc = new ChannelsService({ db, roles, gateway: ctx.gateway, events: ctx.events });

    accounts.onMemberJoin(async (tx, info) => {
      if (info.isOwner) await svc.seedDefaults(tx.as<ChannelsTables>(), info.spaceId);
    });
    accounts.onMemberJoined(async (info) => {
      if (info.isOwner) await svc.reload();
    });

    // Tell each affected user, once the visibility of a channel changed for them.
    roles.onVisibilityChange((userId, added, removed) => {
      for (const id of added) {
        const c = svc.get(id);
        if (c) ctx.gateway.dispatchToUser(userId, "CHANNEL_CREATE", { channel: channelWire(c) });
      }
      for (const id of removed) ctx.gateway.dispatchToUser(userId, "CHANNEL_DELETE", { channelId: id });
    });

    const spaceId = await accounts.spaceId();
    if (spaceId) await db.transaction((tx) => svc.seedDefaults(tx, spaceId));
    await svc.load(spaceId);

    ctx.gateway.contributeReady(async (actor) => {
      const { categories, channels } = await svc.listFor(actor.userId);
      return { categories, channels };
    });

    registerChannelRoutes(ctx.http, svc, roles, accounts);

    const api: ChannelsApi = {
      get: async (id) => svc.get(id),
      list: async () => svc.list(),
    };
    ctx.api.provide("channels", api);
    ctx.capabilities.feature("channels", true);
  },
});
