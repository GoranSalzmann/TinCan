// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

/** Where a GIF comes from. New providers need a server-side adapter and a spot here. */
export const GifProviderSchema = z.enum(["tenor", "giphy"]);
export type GifProvider = z.infer<typeof GifProviderSchema>;

/** Provider post ids double as route params and storage-key segments, so they stay URL- and key-safe. */
export const GifIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

/** Minimal reference the client sends with a message; the server resolves it to full metadata. */
export const GifRefSchema = z.object({ provider: GifProviderSchema, id: GifIdSchema });
export type GifRef = z.infer<typeof GifRefSchema>;

/** Resolved GIF attached to a message: everything the client needs to render inline. */
export const MessageGifSchema = GifRefSchema.extend({
  title: z.string().max(300),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type MessageGif = z.infer<typeof MessageGifSchema>;

/** One result in picker grids. URLs are same-origin (server proxy), never provider URLs. */
export const GifItemSchema = z.object({
  provider: GifProviderSchema,
  id: GifIdSchema,
  title: z.string().max(300),
  previewUrl: z.string(), // same-origin media URL for grid/still display
  mediaUrl: z.string(), // same-origin media URL for full-size display
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type GifItem = z.infer<typeof GifItemSchema>;

/** Search/trending page. `next` is an opaque cursor: "" means "no more". */
export const GifListSchema = z.object({ items: z.array(GifItemSchema), next: z.string() });
export type GifList = z.infer<typeof GifListSchema>;

/** Which variants the media route can serve. */
export const GifVariantSchema = z.enum(["preview", "full", "still"]);
export type GifVariant = z.infer<typeof GifVariantSchema>;
