// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GifProvider } from "@tincan/shared";

/** What the picker can choose: server-side allowlist of provider media hosts (for media fetching). */
export interface ProviderPost {
  id: string;
  title: string;
  /** rendition key -> absolute media URL on an allowlisted host */
  renditions: Record<string, { url: string; width: number; height: number; size?: number }>;
}

export interface ProviderPage {
  posts: ProviderPost[];
  /** opaque cursor for the next page; "" means done */
  next: string;
}

/** A GIF catalog provider: API URL building + response parsing. No network here (testable). */
export interface ProviderAdapter {
  name: GifProvider;
  /** hosts the media fetcher may connect to for this provider */
  mediaHosts: readonly string[];
  /** API base origin, e.g. "https://tenor.googleapis.com" */
  origin: string;
  searchUrl(origin: string, apiKey: string, q: string, pos: string, limit: number, rating: GifRating): string;
  trendingUrl(origin: string, apiKey: string, pos: string, limit: number, rating: GifRating): string;
  /** URL returning one post by id, or null when the provider has no by-id endpoint */
  postUrl(origin: string, apiKey: string, id: string): string;
  parsePage(json: unknown): ProviderPage;
  parsePost(json: unknown): ProviderPost | null;
}

/** Safe-search levels the config offers; each adapter maps them to its own vocabulary. */
export type GifRating = "off" | "low" | "medium" | "high";
export const GIF_RATINGS: readonly GifRating[] = ["off", "low", "medium", "high"];

/** Tenor API v2 (Google). Docs: tenor.googleapis.com/v2. */
export const tenor: ProviderAdapter = {
  name: "tenor",
  mediaHosts: ["media.tenor.com", "c.tenor.com"],
  origin: "https://tenor.googleapis.com",
  searchUrl: (o, key, q, pos, limit, rating) =>
    `${o}/v2/search?key=${encodeURIComponent(key)}&client_key=tincan&q=${encodeURIComponent(q)}` +
    `&limit=${limit}&media_filter=gif,tinygif,mediumgif&contentfilter=${tenorRating(rating)}` +
    (pos ? `&pos=${encodeURIComponent(pos)}` : ""),
  trendingUrl: (o, key, pos, limit, rating) =>
    `${o}/v2/featured?key=${encodeURIComponent(key)}&client_key=tincan&limit=${limit}` +
    `&media_filter=gif,tinygif,mediumgif&contentfilter=${tenorRating(rating)}` +
    (pos ? `&pos=${encodeURIComponent(pos)}` : ""),
  postUrl: (o, key, id) =>
    `${o}/v2/posts?key=${encodeURIComponent(key)}&client_key=tincan&ids=${encodeURIComponent(id)}` +
    `&media_filter=gif,tinygif,mediumgif`,
  parsePage(json) {
    const j = json as { results?: unknown[]; next?: string };
    return { posts: (j.results ?? []).map(tenorPost).filter(Boolean) as ProviderPost[], next: j.next ?? "" };
  },
  parsePost(json) {
    const j = json as { results?: unknown[] };
    const p = j.results?.[0];
    return p ? tenorPost(p) : null;
  },
};

function tenorRating(r: GifRating): string {
  return r === "off" ? "off" : r; // off|low|medium|high — same words
}
interface TenorFormat {
  url?: string;
  dims?: [number, number];
  size?: number;
}
function tenorPost(raw: unknown): ProviderPost | null {
  const r = raw as {
    id?: string;
    content_description?: string;
    title?: string;
    media_formats?: Record<string, TenorFormat>;
  };
  if (!r.id || !r.media_formats) return null;
  const renditions: ProviderPost["renditions"] = {};
  for (const name of ["tinygif", "mediumgif", "gif"] as const) {
    const f = r.media_formats[name];
    if (f?.url && f.dims)
      renditions[name] = { url: f.url, width: f.dims[0], height: f.dims[1], size: f.size };
  }
  if (!renditions.gif && !renditions.mediumgif) return null;
  return { id: r.id, title: (r.content_description ?? r.title ?? "").slice(0, 300) || "GIF", renditions };
}

/** GIPHY API v1. Docs: developers.giphy.com. */
export const giphy: ProviderAdapter = {
  name: "giphy",
  mediaHosts: [
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
    "i.giphy.com",
  ],
  origin: "https://api.giphy.com",
  searchUrl: (o, key, q, pos, limit, rating) =>
    `${o}/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}` +
    `&limit=${limit}&offset=${pos || "0"}&rating=${giphyRating(rating)}&bundle=messaging_non_clips`,
  trendingUrl: (o, key, pos, limit, rating) =>
    `${o}/v1/gifs/trending?api_key=${encodeURIComponent(key)}&limit=${limit}` +
    `&offset=${pos || "0"}&rating=${giphyRating(rating)}&bundle=messaging_non_clips`,
  postUrl: (o, key, id) => `${o}/v1/gifs/${encodeURIComponent(id)}?api_key=${encodeURIComponent(key)}`,
  parsePage(json) {
    const j = json as {
      data?: unknown[];
      pagination?: { offset?: number; count?: number; total_count?: number };
    };
    const p = j.pagination ?? {};
    const next =
      (p.offset ?? 0) + (p.count ?? 0) < (p.total_count ?? 0) ? String((p.offset ?? 0) + (p.count ?? 0)) : "";
    return { posts: (j.data ?? []).map(giphyPost).filter(Boolean) as ProviderPost[], next };
  },
  parsePost(json) {
    const j = json as { data?: unknown };
    return j.data ? giphyPost(j.data) : null;
  },
};

function giphyRating(r: GifRating): string {
  return { off: "r", low: "pg-13", medium: "pg", high: "g" }[r];
}
interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
  size?: string;
}
function giphyPost(raw: unknown): ProviderPost | null {
  const r = raw as { id?: string; title?: string; images?: Record<string, GiphyImage> };
  if (!r.id || !r.images) return null;
  const renditions: ProviderPost["renditions"] = {};
  for (const name of ["fixed_width_small", "fixed_width", "downsized", "original"] as const) {
    const f = r.images[name];
    if (f?.url && f.width && f.height)
      renditions[name] = {
        url: f.url,
        width: +f.width,
        height: +f.height,
        size: f.size ? +f.size : undefined,
      };
  }
  if (!renditions.fixed_width && !renditions.original) return null;
  return { id: r.id, title: (r.title ?? "").slice(0, 300) || "GIF", renditions };
}

export const PROVIDERS: Record<GifProvider, ProviderAdapter> = { tenor, giphy };
