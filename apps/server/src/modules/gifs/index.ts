// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError, GifIdSchema, GifListSchema, GifProviderSchema, GifVariantSchema } from "@tincan/shared";
import { sourceUrlOf } from "../../config/schema.js";
import { defineModule } from "../../framework/types.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import { DEFAULT_SOURCE_URL, VERSION } from "../../version.js";
import type { GifsServiceApi } from "./api.js";
import { GIF_RATINGS, giphy, tenor } from "./providers.js";
import { gifsMigrations, type GifTables } from "./schema.js";
import { GIF_RATE_ROUTE, GifService } from "./service.js";

const ConfigSchema = z.strictObject({
  /** Tenor API v2 key (Google Cloud); empty leaves that provider off. Stays on the server. */
  tenorKey: z.string().prefault(""),
  /** GIPHY API v1 key; empty leaves that provider off. Stays on the server. */
  giphyKey: z.string().prefault(""),
  /** Safe-search level passed to the providers. */
  rating: z.enum(GIF_RATINGS).prefault("medium"),
  /** Largest GIF the server will pull down and re-host. */
  mediaMaxBytes: z
    .number()
    .int()
    .prefault(12 * 1024 * 1024),
  /** Picker pages are cached this long; 0 disables the cache. */
  searchCacheSecs: z.number().int().prefault(300),
  /** Re-hosted media is kept this long and then purged; 0 keeps it forever. */
  mediaCacheDays: z.number().int().prefault(30),
});

/**
 * GIFs (issue #33): members search Tenor/GIPHY in the composer; the server calls the provider,
 * re-hosts the media and serves it same-origin, so the CSP (`img-src 'self'`) stays intact and
 * the API keys never leave the server.
 */
export default defineModule({
  id: "gifs",
  version: VERSION,
  dependsOn: [],
  requiresPorts: ["db", "storage", "pubsub"],
  configSchema: ConfigSchema,
  migrations: gifsMigrations,
  register(ctx) {
    const { storage, pubsub } = ctx.ports;
    const kv = pubsub.kv;
    const providers = [
      ...(ctx.config.tenorKey ? [{ adapter: tenor, apiKey: ctx.config.tenorKey }] : []),
      ...(ctx.config.giphyKey ? [{ adapter: giphy, apiKey: ctx.config.giphyKey }] : []),
    ];
    const svc = new GifService({
      db: ctx.ports.db.as<GifTables>(),
      storage,
      kv,
      providers,
      rating: ctx.config.rating,
      mediaMaxBytes: ctx.config.mediaMaxBytes,
      searchCacheSecs: ctx.config.searchCacheSecs,
      mediaCacheDays: ctx.config.mediaCacheDays,
      log: ctx.log,
      userAgent: `TinCanGif/${VERSION} (+${sourceUrlOf(ctx.core, DEFAULT_SOURCE_URL)})`,
    });
    const api: GifsServiceApi = svc;
    ctx.api.provide("gifs", api);
    ctx.capabilities.feature("gifs", { providers: svc.providers() });

    const http = ctx.http.withTypeProvider<ZodTypeProvider>();
    const query = {
      provider: GifProviderSchema,
      pos: z.string().max(512).optional(),
    };

    http.get(
      "/gifs/search",
      {
        preHandler: ctx.http.authenticate,
        schema: {
          querystring: z.object({ ...query, q: z.string().min(1).max(100) }),
          response: { 200: GifListSchema },
        },
      },
      async (req, reply) => {
        await enforceRateLimit(kv, { key: `gif:search:${req.actor!.userId}`, ...GIF_RATE_ROUTE }, reply);
        return svc.search(req.actor!.userId, req.query.provider, req.query.q, req.query.pos ?? "");
      },
    );

    http.get(
      "/gifs/trending",
      {
        preHandler: ctx.http.authenticate,
        schema: { querystring: z.object({ ...query }), response: { 200: GifListSchema } },
      },
      async (req, reply) => {
        await enforceRateLimit(kv, { key: `gif:search:${req.actor!.userId}`, ...GIF_RATE_ROUTE }, reply);
        return svc.trending(req.actor!.userId, req.query.provider, req.query.pos ?? "");
      },
    );

    // The re-hosted media: same origin, keyed by provider post id, for signed-in members only.
    http.get(
      "/gifs/media/:provider/:id/:variant",
      {
        preHandler: ctx.http.authenticate,
        schema: {
          params: z.object({
            provider: GifProviderSchema,
            id: GifIdSchema,
            variant: GifVariantSchema,
          }),
        },
      },
      async (req, reply) => {
        const m = await svc.media(req.actor!.userId, req.params.provider, req.params.id, req.params.variant);
        if (!m) throw new AppError("NOT_FOUND", "No such GIF.");
        return reply
          .header("Content-Type", m.contentType)
          .header("Content-Disposition", "inline")
          .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
          .header("Cache-Control", "private, max-age=31536000, immutable")
          .send(m.stream);
      },
    );

    // Old re-hosted media goes away on its own; with a 0-day setting nothing is ever removed.
    if (ctx.config.mediaCacheDays > 0)
      ctx.jobs.every(
        "gifs.purge",
        24 * 3_600_000,
        async () => {
          const n = await svc.purge();
          if (n > 0) ctx.log.info({ removed: n }, "removed expired gif media");
        },
        { runOnStart: true },
      );
  },
});
