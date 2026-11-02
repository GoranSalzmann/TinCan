// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LinkPreview } from "@tincan/shared";
import type { FetchNetwork } from "./fetcher.js";

/** What `link-previews` offers other modules (04 §5): a preview for one address, under the owner's policy. */
export interface LinkPreviewApi {
  /**
   * Metadata for a link (title, description, a re-hosted image), or null when previews are off, the address is
   * not allowed, or nothing could be read. Rate-limited per person; cached.
   */
  preview(userId: string, url: string): Promise<LinkPreview | null>;
  /** @internal Replaces the DNS and address rules, for tests only. */
  setNetwork(net: FetchNetwork): void;
}
