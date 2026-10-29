// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AppError, SearchQuerySchema, SearchResultSchema } from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";
import type { ChannelsApi } from "../channels/api.js";
import type { RolesApi } from "../roles/api.js";
import type { TextChatApi } from "../text-chat/api.js";
import type { SearchApi } from "./api.js";
import { searchMigrations, type SearchTables } from "./schema.js";
import { SEARCH_TOPIC, SearchService, type SearchEvent } from "./service.js";

/** Full-text search over the channels a member can read (06 §3.9, 07 §3.6). Fed by the core outbox. */
export default defineModule({
  id: "search",
  version: VERSION,
  dependsOn: ["text-chat"],
  requiresPorts: ["db", "pubsub"],
  migrations: searchMigrations,
  register(ctx) {
    const found = {
      roles: ctx.api.get<RolesApi>("roles"),
      channels: ctx.api.get<ChannelsApi>("channels"),
      accounts: ctx.api.get<AccountsApi>("accounts"),
      text: ctx.api.get<TextChatApi>("text-chat"),
    };
    if (!found.roles || !found.channels || !found.accounts || !found.text)
      throw new AppError("INTERNAL", "search: a dependency is missing");
    const deps = found as {
      roles: RolesApi;
      channels: ChannelsApi;
      accounts: AccountsApi;
      text: TextChatApi;
    };
    const svc = new SearchService({
      db: ctx.ports.db.as<SearchTables>(),
      kv: ctx.ports.pubsub.kv,
      ...deps,
      outbox: ctx.outbox,
    });

    ctx.outbox.subscribe<SearchEvent>(SEARCH_TOPIC, (ev, tx) => svc.apply(ev, tx));

    ctx.http.withTypeProvider<ZodTypeProvider>().get(
      "/search",
      {
        preHandler: ctx.http.authenticate,
        schema: { querystring: SearchQuerySchema, response: { 200: SearchResultSchema } },
      },
      async (req) => svc.search(req.actor!.userId, req.query),
    );

    const api: SearchApi = { reindex: (opts) => svc.reindex(opts) };
    ctx.api.provide("search", api);
    ctx.capabilities.feature("search", true);
  },
});
