// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  LinkPreviewListSchema,
  LinkPreviewSettingsPatchSchema,
  LinkPreviewSettingsSchema,
} from "@tincan/shared";
import { StorageNotFoundError } from "@tincan/storage";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { RolesApi } from "../roles/api.js";
import type { TextChatApi } from "../text-chat/api.js";
import type { LinkPreviewApi } from "./api.js";
import { linkPreviewsMigrations, type LinkPreviewTables } from "./schema.js";
import { LinkPreviewService } from "./service.js";

const ConfigSchema = z.strictObject({
  /** Shown to the sites that are asked, so their owners can see who is calling (23 §8.3). */
  sourceUrl: z.url().default("https://github.com/GoranSalzmann/TinCan"),
});

/** Link previews: the server reads a posted link's title, description and image (23 §8). Off until the owner turns it on. */
export default defineModule({
  id: "link-previews",
  version: VERSION,
  dependsOn: ["roles", "text-chat"],
  requiresPorts: ["db", "storage", "pubsub"],
  configSchema: ConfigSchema,
  migrations: linkPreviewsMigrations,
  async register(ctx) {
    const roles = ctx.api.get<RolesApi>("roles");
    const text = ctx.api.get<TextChatApi>("text-chat");
    if (!roles || !text) throw new AppError("INTERNAL", "link-previews: a dependency is missing");
    const { storage, pubsub } = ctx.ports;
    const svc = new LinkPreviewService({
      db: ctx.ports.db.as<LinkPreviewTables>(),
      storage,
      kv: pubsub.kv,
      roles,
      text,
      events: ctx.events,
      log: ctx.log,
      userAgent: `TinCanLinkPreview/${VERSION} (+${ctx.config.sourceUrl})`,
    });
    await svc.load();
    const publish = () => ctx.capabilities.feature("link-previews", { enabled: svc.settings().enabled });
    publish();

    const http = ctx.http.withTypeProvider<ZodTypeProvider>();
    const Id = z.string().min(1).max(64);

    http.get(
      "/link-previews/messages/:messageId",
      {
        preHandler: ctx.http.authenticate,
        schema: { params: z.object({ messageId: Id }), response: { 200: LinkPreviewListSchema } },
      },
      async (req) => ({ previews: await svc.forMessage(req.actor!.userId, req.params.messageId) }),
    );

    http.delete(
      "/link-previews/messages/:messageId",
      { preHandler: ctx.http.authenticate, schema: { params: z.object({ messageId: Id }) } },
      async (req, reply) => {
        await svc.remove(req.actor!.userId, req.params.messageId);
        return reply.status(204).send();
      },
    );

    // The re-hosted image: same origin, content-addressed, for signed-in members only.
    http.get(
      "/link-previews/image/:hash",
      {
        preHandler: ctx.http.authenticate,
        schema: { params: z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) }) },
      },
      async (req, reply) => {
        try {
          const { stream } = await storage.get(`lp/${req.params.hash}`);
          return reply
            .header("Content-Type", "image/webp")
            .header("Content-Disposition", "inline")
            .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
            .header("Cache-Control", "private, max-age=86400")
            .send(stream);
        } catch (err) {
          if (err instanceof StorageNotFoundError) throw new AppError("NOT_FOUND", "No such image.");
          throw err;
        }
      },
    );

    http.get(
      "/admin/link-previews",
      { preHandler: ctx.http.requireOwner, schema: { response: { 200: LinkPreviewSettingsSchema } } },
      () => svc.settings(),
    );
    http.patch(
      "/admin/link-previews",
      {
        preHandler: ctx.http.requireOwner,
        schema: { body: LinkPreviewSettingsPatchSchema, response: { 200: LinkPreviewSettingsSchema } },
      },
      async (req) => {
        const next = await svc.update(req.actor!.userId, req.body);
        publish();
        return next;
      },
    );

    ctx.events.on("message.deleted", async ({ messageId }) => {
      await svc.forgetMessage(messageId);
    });
    ctx.jobs.every("link-previews.purge", 24 * 3_600_000, async () => {
      const n = await svc.purge();
      if (n > 0) ctx.log.info({ removed: n }, "removed expired link previews");
    });

    const api: LinkPreviewApi = svc;
    ctx.api.provide("link-previews", api);
  },
});
