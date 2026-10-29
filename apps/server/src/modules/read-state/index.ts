// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AckRequestSchema,
  AppError,
  ReadStateEntrySchema,
  has,
  isId,
  type ReadStateEntry,
} from "@tincan/shared";
import { sql, type Db } from "@tincan/db";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { ChannelsApi } from "../channels/api.js";
import type { RolesApi } from "../roles/api.js";
import type { TextChatApi } from "../text-chat/api.js";
import { readStateMigrations, type ReadStateTables } from "./schema.js";

/** Unread and mention tracking (06 §3.8). Counts are computed from committed rows, never stored (18 T29). */
export default defineModule({
  id: "read-state",
  version: VERSION,
  dependsOn: ["text-chat"],
  requiresPorts: ["db"],
  migrations: readStateMigrations,
  register(ctx) {
    const found = {
      roles: ctx.api.get<RolesApi>("roles"),
      channels: ctx.api.get<ChannelsApi>("channels"),
      text: ctx.api.get<TextChatApi>("text-chat"),
    };
    if (!found.roles || !found.channels || !found.text)
      throw new AppError("INTERNAL", "read-state: a dependency is missing");
    const { roles, channels, text } = found as { roles: RolesApi; channels: ChannelsApi; text: TextChatApi };
    const db: Db<ReadStateTables> = ctx.ports.db.as<ReadStateTables>();

    /** State for every text channel the user can see. */
    async function stateFor(userId: string, only?: string[]): Promise<ReadStateEntry[]> {
      const visible = [...(await roles.visibleChannelIds(userId))];
      const wanted = (only ?? visible).filter((id) => visible.includes(id));
      const known = new Set((await channels.list()).filter((c) => c.type === "text").map((c) => c.id));
      const ids = wanted.filter((id) => known.has(id));
      if (ids.length === 0) return [];
      const rows = await db.query
        .selectFrom("read_state")
        .select(["channel_id", "last_read_message_id"])
        .where("user_id", "=", userId)
        .where("channel_id", "in", ids)
        .execute();
      const lastRead = new Map(rows.map((r) => [r.channel_id, r.last_read_message_id]));
      const [latest, mentions] = await Promise.all([
        text.latestMessageIds(ids),
        text.mentionCounts(
          userId,
          await roles.roleIdsOf(userId),
          ids.map((channelId) => ({ channelId, afterId: lastRead.get(channelId) ?? null })),
        ),
      ]);
      return ids.map((channelId) => ({
        channelId,
        lastReadId: lastRead.get(channelId) ?? null,
        latestMessageId: latest.get(channelId) ?? null,
        mentionCount: mentions.get(channelId) ?? 0,
      }));
    }

    const http = ctx.http.withTypeProvider<ZodTypeProvider>();

    http.get(
      "/read-state",
      { preHandler: ctx.http.authenticate, schema: { response: { 200: z.array(ReadStateEntrySchema) } } },
      async (req) => stateFor(req.actor!.userId),
    );

    http.post(
      "/channels/:id/ack",
      {
        preHandler: ctx.http.authenticate,
        schema: {
          params: z.object({ id: z.string().min(1).max(64) }),
          body: AckRequestSchema,
          response: { 200: ReadStateEntrySchema },
        },
      },
      async (req) => {
        const userId = req.actor!.userId;
        const channelId = req.params.id;
        const channel = await channels.get(channelId);
        // A channel you cannot see does not exist as far as you are concerned.
        if (
          !channel ||
          channel.type !== "text" ||
          channel.archivedAt !== null ||
          !has(await roles.permissionsIn(userId, channelId), "VIEW_CHANNEL")
        )
          throw new AppError("NOT_FOUND", "No such channel.");
        if (!isId(req.body.messageId)) throw new AppError("VALIDATION_FAILED", "That is not a message ID.");
        // Never past the newest message, so a bogus ID cannot mark the future as read.
        const latest = (await text.latestMessageIds([channelId])).get(channelId) ?? null;
        const acked = latest !== null && req.body.messageId > latest ? latest : req.body.messageId;
        // Monotonic: a stale device cannot un-read a channel (18 T29).
        await db.query
          .insertInto("read_state")
          .values({
            user_id: userId,
            channel_id: channelId,
            last_read_message_id: acked,
            updated_at: Date.now(),
          })
          .onConflict((oc) =>
            oc.columns(["user_id", "channel_id"]).doUpdateSet({
              last_read_message_id: sql<string>`max(read_state.last_read_message_id, excluded.last_read_message_id)`,
              updated_at: Date.now(),
            }),
          )
          .execute();
        const [entry] = await stateFor(userId, [channelId]);
        if (!entry) throw new AppError("NOT_FOUND", "No such channel.");
        ctx.gateway.dispatchToUser(userId, "READ_STATE_UPDATE", entry);
        return entry;
      },
    );

    ctx.gateway.contributeReady(async (actor) => ({ readState: await stateFor(actor.userId) }));
    ctx.capabilities.feature("read-state", true);
  },
});
