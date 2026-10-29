// SPDX-License-Identifier: AGPL-3.0-or-later
import { statfs } from "node:fs/promises";
import { resolve } from "node:path";
import multipart from "@fastify/multipart";
import type { FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AppError,
  OwnAttachmentsQuerySchema,
  OwnAttachmentSchema,
  StorageUsageSchema,
  UploadResultSchema,
} from "@tincan/shared";
import { StorageNotFoundError } from "@tincan/storage";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "../accounts/api.js";
import type { RolesApi } from "../roles/api.js";
import type { UploadsApi } from "./api.js";
import { INLINE_IMAGE_TYPES } from "./images.js";
import { uploadsMigrations, type UploadsTables } from "./schema.js";
import { AVATAR_MAX_BYTES, UploadsService } from "./service.js";

const ConfigSchema = z.strictObject({
  /** Largest single file (07 §3.7 "size limit from config"). */
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .default(25 * 1024 * 1024),
  /** Per-user total of non-deleted uploads (R-021). */
  userQuotaBytes: z
    .number()
    .int()
    .min(0)
    .default(2 * 1024 * 1024 * 1024),
  /** Log a warning when the storage disk is fuller than this. */
  diskWarnPercent: z.number().int().min(1).max(100).default(85),
  thumbnailSize: z.number().int().min(64).max(2048).default(512),
});

/** `Content-Disposition` with an ASCII fallback and the real name encoded (RFC 6266). */
function disposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export default defineModule({
  id: "uploads",
  version: VERSION,
  dependsOn: ["accounts", "roles"],
  requiresPorts: ["db", "storage", "pubsub"],
  configSchema: ConfigSchema,
  migrations: uploadsMigrations,
  async register(ctx) {
    const found = { accounts: ctx.api.get<AccountsApi>("accounts"), roles: ctx.api.get<RolesApi>("roles") };
    if (!found.accounts || !found.roles) throw new AppError("INTERNAL", "uploads: a dependency is missing");
    const { accounts, roles } = found as { accounts: AccountsApi; roles: RolesApi };
    const { storage, pubsub } = ctx.ports;
    const svc = new UploadsService({
      db: ctx.ports.db.as<UploadsTables>(),
      storage,
      kv: pubsub.kv,
      roles,
      accounts,
      events: ctx.events,
      log: ctx.log,
      settings: ctx.config,
    });

    await ctx.http.register(multipart, {
      limits: { fileSize: ctx.config.maxBytes, files: 1, fields: 4, parts: 6 },
    });
    const http = ctx.http.withTypeProvider<ZodTypeProvider>();

    /** Reads the single file of a multipart request into memory, mapping the plugin's size error. */
    async function readFile(
      req: Parameters<typeof ctx.http.authenticate>[0],
      limit: number,
    ): Promise<{ buffer: Buffer; filename: string | undefined; declaredType: string | undefined }> {
      if (!req.isMultipart())
        throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Send the file as multipart/form-data.");
      const part = await req.file({ limits: { fileSize: limit } });
      if (!part) throw new AppError("VALIDATION_FAILED", "No file was sent.");
      try {
        const buffer = await part.toBuffer();
        return { buffer, filename: part.filename, declaredType: part.mimetype };
      } catch (err) {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
          throw new AppError("PAYLOAD_TOO_LARGE", "That file is too large.", { maxBytes: limit });
        throw err;
      }
    }

    http.post(
      "/uploads",
      { preHandler: ctx.http.authenticate, schema: { response: { 201: UploadResultSchema } } },
      async (req, reply) => {
        const file = await readFile(req, ctx.config.maxBytes);
        const a = await svc.upload(req.actor!.userId, file);
        return reply.status(201).send(a);
      },
    );

    http.delete(
      "/uploads/:id",
      { preHandler: ctx.http.authenticate, schema: { params: z.object({ id: z.string().min(1).max(64) }) } },
      async (req, reply) => {
        await svc.removeOwn(req.actor!.userId, req.params.id);
        return reply.status(204).send();
      },
    );

    http.get(
      "/users/@me/attachments",
      {
        preHandler: ctx.http.authenticate,
        schema: {
          querystring: OwnAttachmentsQuerySchema,
          response: {
            200: z.object({ items: z.array(OwnAttachmentSchema), nextCursor: z.string().nullable() }),
          },
        },
      },
      async (req) => svc.listOwn(req.actor!.userId, req.query),
    );

    http.get(
      "/users/@me/storage",
      { preHandler: ctx.http.authenticate, schema: { response: { 200: StorageUsageSchema } } },
      async (req) => svc.usage(req.actor!.userId),
    );

    // ---- serving (07 §3.7, 15): authenticated, never sniffed, never run as a page ----
    async function send(
      reply: FastifyReply,
      key: string,
      opts: { disposition: string; immutable: boolean },
    ): Promise<FastifyReply> {
      try {
        const { stream, meta } = await storage.get(key);
        return (
          reply
            .header("Content-Type", meta.contentType)
            .header("Content-Disposition", opts.disposition)
            // Even if a type slipped through, nothing here can script the app's origin (18 T20).
            .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
            .header(
              "Cache-Control",
              opts.immutable ? "private, max-age=31536000, immutable" : "private, max-age=3600",
            )
            .send(stream)
        );
      } catch (err) {
        if (err instanceof StorageNotFoundError) throw new AppError("NOT_FOUND", "No such file.");
        throw err;
      }
    }

    http.get(
      "/files/:id/:filename",
      {
        preHandler: ctx.http.authenticate,
        schema: {
          params: z.object({ id: z.string().min(1).max(64), filename: z.string().max(300) }),
          querystring: z.object({ thumb: z.coerce.boolean().optional() }),
        },
      },
      async (req, reply) => {
        const row = await svc.authorizeFile(req.actor!.userId, req.params.id);
        if (req.query.thumb && row.has_thumb === 1) {
          return send(reply, `${row.storage_key}.thumb`, {
            disposition: disposition("inline", "thumbnail.webp"),
            immutable: true,
          });
        }
        const inline = INLINE_IMAGE_TYPES.has(row.content_type);
        return send(reply, row.storage_key, {
          disposition: disposition(inline ? "inline" : "attachment", row.filename),
          immutable: true,
        });
      },
    );

    // ---- avatars ----
    http.put("/users/@me/avatar", { preHandler: ctx.http.authenticate }, async (req, reply) => {
      const file = await readFile(req, AVATAR_MAX_BYTES);
      const avatarKey = await svc.setAvatar(req.actor!.userId, file.buffer);
      return reply.send({ avatarKey });
    });
    http.delete("/users/@me/avatar", { preHandler: ctx.http.authenticate }, async (req, reply) => {
      await svc.clearAvatar(req.actor!.userId);
      return reply.status(204).send();
    });
    http.get(
      "/avatars/:name",
      {
        preHandler: ctx.http.authenticate,
        schema: { params: z.object({ name: z.string().regex(/^[A-Za-z0-9]{26}-[0-9a-f]{12}\.webp$/) }) },
      },
      async (req, reply) =>
        send(reply, `avatar/${req.params.name}`, { disposition: "inline", immutable: true }),
    );

    // A file whose message or channel is gone goes with it.
    ctx.events.on("message.deleted", ({ messageId }) => svc.removeFor({ messageId }));
    ctx.events.on("channel.deleted", ({ channelId }) => svc.removeFor({ channelId }));

    ctx.jobs.every("uploads.gc", 24 * 3_600_000, async () => {
      const n = await svc.collectOrphans();
      if (n > 0) ctx.log.info({ removed: n }, "removed orphaned uploads");
    });
    ctx.jobs.every("uploads.disk", 10 * 60_000, async () => {
      try {
        const s = await statfs(resolve(ctx.core.adapters.storage.path));
        const used = 100 * (1 - s.bavail / s.blocks);
        if (used >= ctx.config.diskWarnPercent)
          ctx.log.warn({ usedPercent: Math.round(used) }, "the storage disk is nearly full");
      } catch {
        // statfs is best effort (some filesystems do not report it)
      }
    });

    ctx.capabilities.feature("uploads", {
      maxBytes: ctx.config.maxBytes,
      userQuotaBytes: ctx.config.userQuotaBytes,
    });
    ctx.capabilities.limit("uploadMaxBytes", ctx.config.maxBytes);

    const api: UploadsApi = svc;
    ctx.api.provide("uploads", api);
  },
});
