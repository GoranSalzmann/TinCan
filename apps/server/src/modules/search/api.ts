// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ReindexResult {
  /** Live messages queued for (re)indexing. */
  queued: number;
  /** Index entries for messages that no longer exist, queued for removal. */
  removed: number;
}

/** What `search` offers the admin CLI (`tincan search reindex`, 18 T29). */
export interface SearchApi {
  /**
   * Rebuilds the index from the messages, online, in short transactions. Work goes through the core
   * outbox, so it interleaves correctly with edits that happen meanwhile; the caller waits for the
   * outbox to empty.
   */
  reindex(opts?: { batchSize?: number; onProgress?: (done: number) => void }): Promise<ReindexResult>;
}
