// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { Db } from "@tincan/db";
import type { Kv } from "@tincan/pubsub";
import { AppError, extractPreviewUrls, type LinkPreview, type LinkPreviewSettings } from "@tincan/shared";
import type { Storage } from "@tincan/storage";
import type { EventBus } from "../../framework/events.js";
import type { Logger } from "../../framework/types.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import type { RolesApi } from "../roles/api.js";
import type { TextChatApi } from "../text-chat/api.js";
import { defaultNetwork, FetchError, safeFetch, type FetchLimits, type FetchNetwork } from "./fetcher.js";
import type { LinkPreviewApi } from "./api.js";
import {
  absoluteHttpUrl,
  cleanText,
  DESCRIPTION_MAX,
  decodeBody,
  fromMeta,
  parseHead,
  plainTextFromHtml,
  SITE_NAME_MAX,
  TITLE_MAX,
  type Unfurled,
} from "./parse.js";
import { domainMatches, providerFor, type OembedProvider } from "./providers.js";
import type { LinkPreviewTables } from "./schema.js";

/** Limits of the fetcher (23 §8.3). */
export const HTML_MAX_BYTES = 256 * 1024;
export const JSON_MAX_BYTES = 64 * 1024;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 5000;
export const PREVIEW_TIMEOUT_MS = 8000;
export const MAX_REDIRECTS = 3;
export const IMAGE_FIT_PX = 640;
export const RATE_PER_USER = 20;
export const RATE_PER_SERVER = 120;
const RATE_WINDOW_MS = 60_000;
export const TTL_OK_MS = 24 * 3_600_000;
export const TTL_NONE_MS = 3_600_000;

const HTML: FetchLimits = {
  maxBytes: HTML_MAX_BYTES,
  onLimit: "truncate",
  timeoutMs: REQUEST_TIMEOUT_MS,
  maxRedirects: MAX_REDIRECTS,
  accept: "text/html,application/xhtml+xml;q=0.9",
  types: ["text/html", "application/xhtml+xml"],
};
const JSON_LIMITS: FetchLimits = {
  maxBytes: JSON_MAX_BYTES,
  onLimit: "fail",
  timeoutMs: REQUEST_TIMEOUT_MS,
  maxRedirects: MAX_REDIRECTS,
  accept: "application/json",
  types: ["application/json", "text/json", "application/json+oembed", "text/javascript"],
};
const IMAGE: FetchLimits = {
  maxBytes: IMAGE_MAX_BYTES,
  onLimit: "fail",
  timeoutMs: REQUEST_TIMEOUT_MS,
  maxRedirects: MAX_REDIRECTS,
  accept: "image/webp,image/png,image/jpeg,image/gif",
  types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
};

export const DEFAULT_SETTINGS: LinkPreviewSettings = { enabled: false, allowDomains: [], denyDomains: [] };

export interface LinkPreviewsDeps {
  db: Db<LinkPreviewTables>;
  storage: Storage;
  kv: Kv;
  roles: RolesApi;
  text: TextChatApi;
  events: EventBus;
  log: Logger;
  userAgent: string;
  network?: FetchNetwork;
}

interface Stored {
  siteName: string | null;
  title: string | null;
  description: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  video: boolean;
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** Link previews: the cache, the owner's policy and the fetching (23 §8). */
export class LinkPreviewService implements LinkPreviewApi {
  readonly #d: LinkPreviewsDeps;
  #net: FetchNetwork;
  #settings: LinkPreviewSettings = { ...DEFAULT_SETTINGS };
  readonly #inFlight = new Map<string, Promise<LinkPreview | null>>();

  constructor(deps: LinkPreviewsDeps) {
    this.#d = deps;
    this.#net = deps.network ?? defaultNetwork;
  }

  /** @internal Tests swap in a fake resolver and permissive address rules. */
  setNetwork(net: FetchNetwork): void {
    this.#net = net;
  }

  // ---- settings ------------------------------------------------------------------------------

  settings(): LinkPreviewSettings {
    return { ...this.#settings };
  }

  async load(): Promise<void> {
    const row = await this.#d.db.query
      .selectFrom("link_preview_setting")
      .select("value")
      .where("key", "=", "settings")
      .executeTakeFirst();
    if (!row) return;
    try {
      const v = JSON.parse(row.value) as Partial<LinkPreviewSettings>;
      this.#settings = {
        enabled: v.enabled === true,
        allowDomains: Array.isArray(v.allowDomains) ? v.allowDomains.map(String) : [],
        denyDomains: Array.isArray(v.denyDomains) ? v.denyDomains.map(String) : [],
      };
    } catch {
      this.#d.log.warn("link-previews: stored settings could not be read; previews stay off");
    }
  }

  async update(actorId: string, patch: Partial<LinkPreviewSettings>): Promise<LinkPreviewSettings> {
    const next = { ...this.#settings, ...patch };
    const value = JSON.stringify(next);
    await this.#d.db.query
      .insertInto("link_preview_setting")
      .values({ key: "settings", value })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
      .execute();
    this.#settings = next;
    this.#d.events.emit("audit.record", {
      actorId,
      action: "linkpreviews.settings",
      data: { enabled: next.enabled, allow: next.allowDomains.length, deny: next.denyDomains.length },
    });
    return this.settings();
  }

  /** The owner's policy for one address: previews on, not denied, and on the allow list when there is one. */
  allowed(url: string): boolean {
    if (!this.#settings.enabled) return false;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    const { allowDomains, denyDomains } = this.#settings;
    if (denyDomains.some((d) => domainMatches(host, d))) return false;
    return allowDomains.length === 0 || allowDomains.some((d) => domainMatches(host, d));
  }

  // ---- per message ---------------------------------------------------------------------------

  async #messageFor(userId: string, messageId: string) {
    const [m] = await this.#d.text.getMessages([messageId]);
    // Not found and not visible look the same.
    if (!m || !(await this.#d.roles.can(userId, "VIEW_CHANNEL", m.channelId)))
      throw new AppError("NOT_FOUND", "No such message.");
    return m;
  }

  async forMessage(userId: string, messageId: string): Promise<LinkPreview[]> {
    if (!this.#settings.enabled) return [];
    const m = await this.#messageFor(userId, messageId);
    const hidden = await this.#d.db.query
      .selectFrom("link_preview_suppressed")
      .select("message_id")
      .where("message_id", "=", messageId)
      .executeTakeFirst();
    if (hidden) return [];
    const urls = extractPreviewUrls(m.content).filter((u) => this.allowed(u));
    const found = await Promise.all(urls.map((u) => this.#lookup(userId, u).catch(() => null)));
    return found.filter((p): p is LinkPreview => p !== null);
  }

  async remove(userId: string, messageId: string): Promise<void> {
    const m = await this.#messageFor(userId, messageId);
    const own = m.authorId === userId;
    if (!own) await this.#d.roles.assert(userId, "MANAGE_MESSAGES", m.channelId);
    await this.#d.db.query
      .insertInto("link_preview_suppressed")
      .values({ message_id: messageId, by_user: userId, at: Date.now() })
      .onConflict((oc) => oc.column("message_id").doNothing())
      .execute();
    if (!own)
      this.#d.events.emit("audit.record", {
        actorId: userId,
        action: "message.preview.remove",
        targetType: "message",
        targetId: messageId,
        data: { channelId: m.channelId, authorId: m.authorId },
      });
  }

  forgetMessage(messageId: string): Promise<unknown> {
    return this.#d.db.query
      .deleteFrom("link_preview_suppressed")
      .where("message_id", "=", messageId)
      .execute();
  }

  // ---- lookup and cache ----------------------------------------------------------------------

  /** One address, from the cache or the network. Null: nothing to show. Callers have applied the owner's policy. */
  async #lookup(userId: string, url: string): Promise<LinkPreview | null> {
    const hash = sha256(url);
    const now = Date.now();
    const hit = await this.#d.db.query
      .selectFrom("link_preview_cache")
      .selectAll()
      .where("url_hash", "=", hash)
      .executeTakeFirst();
    if (hit && hit.expires_at > now) return this.#fromRow(url, hit);
    const running = this.#inFlight.get(hash);
    if (running) return running;
    const job = (async () => {
      try {
        // A fetch costs the server something; cache hits above do not count.
        await enforceRateLimit(this.#d.kv, {
          key: `lp:user:${userId}`,
          max: RATE_PER_USER,
          windowMs: RATE_WINDOW_MS,
        });
        await enforceRateLimit(this.#d.kv, {
          key: "lp:server",
          max: RATE_PER_SERVER,
          windowMs: RATE_WINDOW_MS,
        });
      } catch {
        return null; // over the limit: show no card now, ask again later (nothing is cached)
      }
      return this.#fetchAndStore(url, hash);
    })().finally(() => this.#inFlight.delete(hash));
    this.#inFlight.set(hash, job);
    return job;
  }

  /** Fetches a preview for any module that wants one (the policy still applies). */
  async preview(userId: string, url: string): Promise<LinkPreview | null> {
    if (!this.allowed(url)) return null;
    return this.#lookup(userId, url);
  }

  #fromRow(url: string, r: LinkPreviewTables["link_preview_cache"]): LinkPreview | null {
    if (r.ok !== 1 || !r.data) return null;
    const s = JSON.parse(r.data) as Stored;
    return { url, ...s, image: r.image_hash };
  }

  async #fetchAndStore(url: string, hash: string): Promise<LinkPreview | null> {
    const started = Date.now();
    let result: (Stored & { imageHash: string | null }) | null = null;
    try {
      result = await this.#withDeadline(this.#unfurl(url));
    } catch (err) {
      const reason = err instanceof FetchError ? err.reason : "error";
      this.#d.log.info({ reason, ms: Date.now() - started }, "link preview not made");
    }
    const now = Date.now();
    const { imageHash, ...stored } = result ?? ({} as Stored & { imageHash: string | null });
    const row: LinkPreviewTables["link_preview_cache"] = {
      url_hash: hash,
      url,
      ok: result ? 1 : 0,
      data: result ? JSON.stringify(stored) : null,
      image_hash: result?.imageHash ?? null,
      fetched_at: now,
      expires_at: now + (result ? TTL_OK_MS : TTL_NONE_MS),
    };
    await this.#d.db.query
      .insertInto("link_preview_cache")
      .values(row)
      .onConflict((oc) => oc.column("url_hash").doUpdateSet(row))
      .execute();
    return this.#fromRow(url, row);
  }

  #withDeadline<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new FetchError("timeout", "preview took too long")),
        PREVIEW_TIMEOUT_MS,
      );
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(t);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  // ---- unfurling -----------------------------------------------------------------------------

  async #get(url: string, limits: FetchLimits) {
    return safeFetch(url, limits, this.#net, this.#d.userAgent);
  }

  async #unfurl(url: string): Promise<(Stored & { imageHash: string | null }) | null> {
    const u = new URL(url);
    const provider = providerFor(u);
    let found: Unfurled | null = null;
    if (provider) found = await this.#oembed(provider, u).catch(() => null);
    if (!found || (provider?.descriptionFromPage && !found.description)) {
      const page = await this.#page(url).catch((err: unknown) => {
        if (!found) throw err;
        return null;
      });
      if (page) found = found ? { ...found, description: found.description ?? page.description } : page;
    }
    if (!found || (!found.title && !found.description && !found.imageUrl)) return null;
    const image = found.imageUrl ? await this.#image(found.imageUrl).catch(() => null) : null;
    return {
      siteName: found.siteName,
      title: found.title,
      description: found.description,
      imageWidth: image?.width ?? null,
      imageHeight: image?.height ?? null,
      imageHash: image?.hash ?? null,
      video: found.video,
    };
  }

  /** The page's own tags, then an oEmbed address the page advertises when it has no usable tags. */
  async #page(url: string): Promise<Unfurled | null> {
    const res = await this.#get(url, HTML);
    // The owner's deny list also applies to where the link ended up.
    if (!this.allowed(res.finalUrl)) return null;
    const head = parseHead(decodeBody(res.body, res.charset));
    const meta = fromMeta(head, res.finalUrl);
    if (!meta.title && !meta.imageUrl && head.oembedHref) {
      const href = absoluteHttpUrl(head.oembedHref, res.finalUrl);
      if (href) {
        const viaDiscovery = await this.#oembedAt(href, res.finalUrl, null).catch(() => null);
        if (viaDiscovery) return viaDiscovery;
      }
    }
    return meta;
  }

  #oembed(provider: OembedProvider, u: URL): Promise<Unfurled | null> {
    return this.#oembedAt(provider.endpoint(u), u.href, provider);
  }

  async #oembedAt(
    endpoint: string,
    pageUrl: string,
    provider: OembedProvider | null,
  ): Promise<Unfurled | null> {
    const res = await this.#get(endpoint, JSON_LIMITS);
    let j: unknown;
    try {
      j = JSON.parse(res.body.toString("utf8"));
    } catch {
      return null;
    }
    if (!j || typeof j !== "object") return null;
    const o = j as Record<string, unknown>;
    const str = (k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
    const author = cleanText(str("author_name"), SITE_NAME_MAX);
    const isPost = provider?.name === "X";
    const html = str("html");
    return {
      siteName: provider?.name ?? cleanText(str("provider_name"), SITE_NAME_MAX),
      title: isPost && author ? cleanText(`${author} on X`, TITLE_MAX) : cleanText(str("title"), TITLE_MAX),
      // An embedded post is its text; for others the channel or author stands in until the page gives a description.
      description:
        isPost && html
          ? plainTextFromHtml(html, DESCRIPTION_MAX)
          : (cleanText(str("description"), DESCRIPTION_MAX) ?? author),
      imageUrl: absoluteHttpUrl(str("thumbnail_url"), pageUrl),
      video: provider?.video === true || str("type") === "video",
    };
  }

  /** Fetches an image through the same checks and keeps only a small re-encoded copy on this server. */
  async #image(url: string): Promise<{ hash: string; width: number; height: number } | null> {
    const res = await this.#get(url, IMAGE);
    const { data, info } = await sharp(res.body, { limitInputPixels: 24_000_000, failOn: "error" })
      .rotate()
      .resize(IMAGE_FIT_PX, IMAGE_FIT_PX, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer({ resolveWithObject: true });
    const hash = sha256(data);
    const key = `lp/${hash}`;
    if (!(await this.#d.storage.exists(key)))
      await this.#d.storage.put(key, Readable.from([data]), { contentType: "image/webp" });
    return { hash, width: info.width, height: info.height };
  }

  // ---- housekeeping --------------------------------------------------------------------------

  /** Removes expired entries and images nothing refers to any more. Returns how many entries went. */
  async purge(): Promise<number> {
    const cutoff = Date.now() - 24 * 3_600_000;
    const old = await this.#d.db.query
      .selectFrom("link_preview_cache")
      .select(["url_hash", "image_hash"])
      .where("expires_at", "<", cutoff)
      .execute();
    if (old.length === 0) return 0;
    await this.#d.db.query
      .deleteFrom("link_preview_cache")
      .where(
        "url_hash",
        "in",
        old.map((r) => r.url_hash),
      )
      .execute();
    for (const h of new Set(old.map((r) => r.image_hash).filter((h): h is string => h !== null))) {
      const still = await this.#d.db.query
        .selectFrom("link_preview_cache")
        .select("url_hash")
        .where("image_hash", "=", h)
        .executeTakeFirst();
      if (!still) await this.#d.storage.delete(`lp/${h}`).catch(() => undefined);
    }
    return old.length;
  }
}
