// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GifList, GifProvider, MessageGif } from "@tincan/shared";
import type { Readable } from "node:stream";
import type { FetchNetwork } from "../../net/fetcher.js";

/** What other modules may use: resolve a gif ref for message attach, and list configured providers. */
export interface GifsApi {
  /** Providers with a configured API key (empty = feature off). */
  providers(): GifProvider[];
  /** Full metadata for message creation, or null when the post does not resolve. */
  describe(provider: GifProvider, id: string): Promise<MessageGif | null>;
}

export interface GifMedia {
  stream: Readable;
  contentType: string;
  size: number;
}

/** Internal surface: everything the module's routes call. */
export interface GifsServiceApi extends GifsApi {
  search(userId: string, provider: GifProvider, q: string, pos: string): Promise<GifList>;
  trending(userId: string, provider: GifProvider, pos: string): Promise<GifList>;
  media(
    userId: string,
    provider: GifProvider,
    id: string,
    variant: "preview" | "full" | "still",
  ): Promise<GifMedia | null>;
  /** @internal Replaces the DNS and address rules, for tests only. */
  setNetwork(network: FetchNetwork): void;
  /** @internal Points the provider APIs at a test server, for tests only. */
  setOrigins(origins: Partial<Record<GifProvider, string>>): void;
}
