// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { Db } from "@tincan/db";
import type { Kv } from "@tincan/pubsub";
import {
  AppError,
  GifProviderSchema,
  type GifItem,
  type GifList,
  type GifProvider,
  type MessageGif,
} from "@tincan/shared";
import type { Storage } from "@tincan/storage";
import type { Logger } from "../../framework/types.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import {
  defaultNetwork,
  FetchError,
  safeFetch,
  type FetchLimits,
  type FetchNetwork,
} from "../../net/fetcher.js";
import type { GifMedia, GifsServiceApi } from "./api.js";
import type { GifRating, ProviderAdapter, ProviderPost } from "./providers.js";
import type { GifTables } from "./schema.js";

/** Limits of the fetcher (23 §8.3): small JSON answers, capped GIF bytes. */
const JSON_MAX_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const MEDIA_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
/** Picker page size. */
const PAGE_LIMIT = 24;
const RATE_WINDOW_MS = 60_000;
/** Upstream calls a member may cause, and the whole server, per minute. */
const RATE_PER_USER = 60;
const RATE_PER_SERVER = 600;
const RATE_MEDIA_PER_USER = 120;
const RATE_ROUTE_PER_USER = 30;
export const GIF_RATE_ROUTE = { max: RATE_ROUTE_PER_USER, windowMs: RATE_WINDOW_MS };
const POST_TTL_MS = 24 * 3_600_000;

const JSON_LIMITS: FetchLimits = {
  maxBytes: JSON_MAX_BYTES,
  onLimit: "fail",
  timeoutMs: REQUEST_TIMEOUT_MS,
  maxRedirects: MAX_REDIRECTS,
  accept: "application/json",
  types: ["application/json", "text/json"],
};
const mediaLimits = (maxBytes: number): FetchLimits => ({
  maxBytes,
  onLimit: "fail",
  timeoutMs: MEDIA_TIMEOUT_MS,
  maxRedirects: MAX_REDIRECTS,
  accept: "image/gif",
  types: ["image/gif"],
});

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Rendition keys in preference order, for each adapter's vocabulary. */
const PREVIEW_KEYS = ["tinygif", "fixed_width_small", "fixed_width"];
const FULL_KEYS = ["gif", "downsized", "original"];

/** The picker shows same-origin URLs only: members' browsers never talk to Tenor or GIPHY (CSP img-src 'self'). */
const mediaPath = (provider: GifProvider, id: string, variant: string): string =>
  `/api/v1/gifs/media/${provider}/${encodeURIComponent(id)}/${variant}`;

function rendition(
  post: ProviderPost,
  variant: "preview" | "full" | "still",
): ProviderPost["renditions"][string] | null {
  const preferred = variant === "preview" ? PREVIEW_KEYS : FULL_KEYS;
  const fallback = variant === "preview" ? FULL_KEYS : PREVIEW_KEYS;
  for (const k of [...preferred, ...fallback]) {
    const r = post.renditions[k];
    if (r) return r;
  }
  return null;
}

interface Configured {
  adapter: ProviderAdapter;
  apiKey: string;
  /** API origin; `setOrigins` rewrites it in tests. */
  origin: string;
}

export interface GifsDeps {
  db: Db<GifTables>;
  storage: Storage;
  kv: Kv;
  /** Providers that have an API key, in picker order. */
  providers: { adapter: ProviderAdapter; apiKey: string; origin?: string }[];
  rating: GifRating;
  mediaMaxBytes: number;
  searchCacheSecs: number;
  mediaCacheDays: number;
  log: Logger;
  userAgent: string;
}

/**
 * GIF search and media (issue #33): the server talks to the provider, answers are cached in the kv,
 * media bytes are re-hosted through `GET /gifs/media/…` so the member's browser never leaves the origin.
 */
export class GifService implements GifsServiceApi {
  readonly #d: GifsDeps;
  readonly #providers: Configured[];
  #net: FetchNetwork;
  /** One upstream page request or media fetch per key at a time. */
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(deps: GifsDeps) {
    this.#d = deps;
    this.#providers = deps.providers.map((p) => ({
      adapter: p.adapter,
      apiKey: p.apiKey,
      origin: p.origin ?? p.adapter.origin,
    }));
    this.#net = defaultNetwork;
  }

  /** @internal Tests swap in a fake resolver and permissive address rules. */
  setNetwork(net: FetchNetwork): void {
    this.#net = net;
  }

  /** @internal Tests point the provider APIs at a local server. */
  setOrigins(origins: Partial<Record<GifProvider, string>>): void {
    for (const p of this.#providers) {
      const origin = origins[p.adapter.name];
      if (origin) p.origin = origin;
    }
  }

  providers(): GifProvider[] {
    return this.#providers.map((p) => p.adapter.name);
  }

  /** The configured provider entry, or a 400 when the name is unknown or has no key. */
  #provider(name: GifProvider): Configured {
    const parsed = GifProviderSchema.safeParse(name);
    if (!parsed.success) throw new AppError("BAD_REQUEST", "Unknown GIF provider.");
    const p = this.#providers.find((x) => x.adapter.name === parsed.data);
    if (!p)
      throw new AppError("BAD_REQUEST", "That GIF provider is not set up on this server.", {
        reason: "GIF_PROVIDER",
      });
    return p;
  }

  async #upstreamLimits(userId: string): Promise<void> {
    // Each picker page costs the server's API key a call; per-person first, then the shared budget.
    await enforceRateLimit(this.#d.kv, {
      key: `gif:up:${userId}`,
      max: RATE_PER_USER,
      windowMs: RATE_WINDOW_MS,
    });
    await enforceRateLimit(this.#d.kv, { key: "gif:up", max: RATE_PER_SERVER, windowMs: RATE_WINDOW_MS });
  }

  async #get(url: string, limits: FetchLimits) {
    return safeFetch(url, limits, this.#net, this.#d.userAgent);
  }

  async #json(url: string): Promise<unknown> {
    const res = await this.#get(url, JSON_LIMITS);
    return JSON.parse(res.body.toString("utf8")) as unknown;
  }

  // ---- search and trending ---------------------------------------------------------------------

  async search(userId: string, provider: GifProvider, q: string, pos: string): Promise<GifList> {
    const p = this.#provider(provider);
    return this.#page(userId, p, "search", q, pos);
  }

  async trending(userId: string, provider: GifProvider, pos: string): Promise<GifList> {
    const p = this.#provider(provider);
    return this.#page(userId, p, "trending", "", pos);
  }

  /** One picker page, cached and single-flighted so a grid full of clients asks upstream once. */
  async #page(
    userId: string,
    p: Configured,
    kind: "search" | "trending",
    q: string,
    pos: string,
  ): Promise<GifList> {
    const cacheKey = `gif:s:${p.adapter.name}:${kind}:${sha256(`${q}\n${pos}`)}`;
    if (this.#d.searchCacheSecs > 0) {
      const cached = await this.#d.kv.get(cacheKey);
      if (cached) return JSON.parse(cached) as GifList;
    }
    const running = this.#inFlight.get(cacheKey);
    if (running) return running as Promise<GifList>;
    const job = (async (): Promise<GifList> => {
      await this.#upstreamLimits(userId);
      const url =
        kind === "search"
          ? p.adapter.searchUrl(p.origin, p.apiKey, q, pos, PAGE_LIMIT, this.#d.rating)
          : p.adapter.trendingUrl(p.origin, p.apiKey, pos, PAGE_LIMIT, this.#d.rating);
      const page = p.adapter.parsePage(await this.#json(url));
      const list: GifList = {
        items: page.posts
          .map((post) => this.#item(p.adapter.name, post))
          .filter((x): x is GifItem => x !== null),
        next: page.next,
      };
      if (this.#d.searchCacheSecs > 0)
        await this.#d.kv.set(cacheKey, JSON.stringify(list), { ttlMs: this.#d.searchCacheSecs * 1000 });
      return list;
    })().finally(() => this.#inFlight.delete(cacheKey));
    this.#inFlight.set(cacheKey, job);
    return job;
  }

  #item(provider: GifProvider, post: ProviderPost): GifItem | null {
    const full = rendition(post, "full");
    if (!full) return null;
    return {
      provider,
      id: post.id,
      title: post.title,
      previewUrl: mediaPath(provider, post.id, "preview"),
      mediaUrl: mediaPath(provider, post.id, "full"),
      width: full.width,
      height: full.height,
    };
  }

  // ---- one post ---------------------------------------------------------------------------------

  async describe(provider: GifProvider, id: string): Promise<MessageGif | null> {
    const parsed = GifProviderSchema.safeParse(provider);
    if (!parsed.success) return null;
    const p = this.#providers.find((x) => x.adapter.name === parsed.data);
    if (!p) return null;
    const post = await this.#post(p, id);
    if (!post) return null;
    const full = rendition(post, "full");
    // A GIF the media route could never re-host (media on an unlisted host) must not be sendable.
    if (!full || !this.#mediaAllowed(p, full.url)) return null;
    return { provider: parsed.data, id: post.id, title: post.title, width: full.width, height: full.height };
  }

  /** The rendition may only come from the provider's own media hosts; anything else is not fetched. */
  #mediaAllowed(p: Configured, url: string): boolean {
    try {
      return p.adapter.mediaHosts.includes(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  /** The provider's post record, cached a day: message creation and media fetch share it. */
  async #post(p: Configured, id: string): Promise<ProviderPost | null> {
    const cacheKey = `gif:p:${p.adapter.name}:${id}`;
    const cached = await this.#d.kv.get(cacheKey);
    if (cached) return JSON.parse(cached) as ProviderPost;
    try {
      const post = p.adapter.parsePost(await this.#json(p.adapter.postUrl(p.origin, p.apiKey, id)));
      if (post) await this.#d.kv.set(cacheKey, JSON.stringify(post), { ttlMs: POST_TTL_MS });
      return post;
    } catch (err) {
      if (err instanceof FetchError || err instanceof SyntaxError) {
        this.#d.log.info(
          { reason: err instanceof FetchError ? err.reason : "parse", provider: p.adapter.name, id },
          "gif post did not resolve",
        );
        return null;
      }
      throw err;
    }
  }

  // ---- media -------------------------------------------------------------------------------------

  async media(
    userId: string,
    provider: GifProvider,
    id: string,
    variant: "preview" | "full" | "still",
  ): Promise<GifMedia | null> {
    const parsed = GifProviderSchema.safeParse(provider);
    if (!parsed.success) return null;
    const p = this.#providers.find((x) => x.adapter.name === parsed.data);
    if (!p) return null;
    await enforceRateLimit(this.#d.kv, {
      key: `gif:media:${userId}`,
      max: RATE_MEDIA_PER_USER,
      windowMs: RATE_WINDOW_MS,
    });
    const key = `gifs/${parsed.data}/${id}/${variant}`;
    if (!(await this.#d.storage.exists(key))) {
      // Fetch and store once per key; every waiter then reads the stored copy for itself.
      const running = this.#inFlight.get(key);
      const job =
        (running as Promise<boolean> | undefined) ??
        this.#fetchAndStore(p, id, variant, key).finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, job);
      if (!(await job)) return null;
    }
    const { stream, meta } = await this.#d.storage.get(key);
    return { stream, contentType: meta.contentType, size: meta.size };
  }

  /** Downloads one rendition onto an allowlisted host and stores the bytes under `key`. */
  async #fetchAndStore(
    p: Configured,
    id: string,
    variant: "preview" | "full" | "still",
    key: string,
  ): Promise<boolean> {
    try {
      const post = await this.#post(p, id);
      if (!post) return false;
      const r = rendition(post, variant);
      if (!r || !this.#mediaAllowed(p, r.url)) return false;
      const res = await this.#get(r.url, mediaLimits(this.#d.mediaMaxBytes));
      let data = res.body;
      let contentType = "image/gif";
      if (variant === "still") {
        // The first frame as WebP: what reduced-motion shows until the member asks for the animation.
        data = await sharp(res.body, { limitInputPixels: 24_000_000, failOn: "error" })
          .webp({ quality: 75 })
          .toBuffer();
        contentType = "image/webp";
      }
      await this.#d.storage.put(key, Readable.from([data]), { contentType, size: data.length });
      await this.#d.db.query
        .insertInto("gif_media")
        .values({ key, content_type: contentType, bytes: data.length, fetched_at: Date.now() })
        .onConflict((oc) =>
          oc
            .column("key")
            .doUpdateSet({ content_type: contentType, bytes: data.length, fetched_at: Date.now() }),
        )
        .execute();
      return true;
    } catch (err) {
      const reason = err instanceof FetchError ? err.reason : "error";
      this.#d.log.info({ reason, provider: p.adapter.name, id, variant }, "gif media not fetched");
      return false;
    }
  }

  // ---- housekeeping ------------------------------------------------------------------------------

  /** Drops re-hosted media older than `mediaCacheDays` (0 keeps everything). Called by the daily job. */
  async purge(): Promise<number> {
    const days = this.#d.mediaCacheDays;
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * 24 * 3_600_000;
    const old = await this.#d.db.query
      .selectFrom("gif_media")
      .select("key")
      .where("fetched_at", "<", cutoff)
      .execute();
    for (const row of old) {
      try {
        await this.#d.storage.delete(row.key);
      } catch {
        // Gone already; the row goes either way.
      }
      await this.#d.db.query.deleteFrom("gif_media").where("key", "=", row.key).execute();
    }
    return old.length;
  }
}
