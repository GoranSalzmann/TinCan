// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "@tincan/db";
import type { Message } from "@tincan/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the caller's transaction, narrowed here
type AnyDb = Db<any>;

export interface SearchDocument {
  id: string;
  channelId: string;
  authorId: string;
  text: string;
}

/** What `text-chat` offers `read-state` and `search` (04 §5): read access without touching its tables. */
export interface TextChatApi {
  /** Hydrated messages (authors, reply references, attachments, mentions), in the order of `ids`; deleted ones are left out. */
  getMessages(ids: readonly string[]): Promise<Message[]>;
  latestMessageIds(channelIds: readonly string[]): Promise<Map<string, string>>;
  /**
   * Mentions of the user (directly, through one of their roles, or `@everyone`) after each channel's
   * read position. Computed from `message_mention`, so nothing can drift (18 T29).
   */
  mentionCounts(
    userId: string,
    roleIds: readonly string[],
    entries: readonly { channelId: string; afterId: string | null }[],
  ): Promise<Map<string, number>>;
  /** True when the message exists in that channel and is not deleted. */
  messageExists(channelId: string, messageId: string): Promise<boolean>;
  /**
   * Live messages after `afterId` in ID order, for `search reindex`. Pass the caller's transaction to
   * read inside it, so a document is never queued after a newer edit has already been indexed.
   */
  documents(afterId: string | null, limit: number, tx?: AnyDb): Promise<SearchDocument[]>;
  /** The subset of `ids` that are live messages. */
  existingIds(ids: readonly string[]): Promise<Set<string>>;
  /** The text that goes into the search index for a message. */
  searchText(content: string): string;
  /** Deletes an author's messages created at or after `sinceMs` (the ban purge window, 11 §3). Returns how many. */
  purgeAuthor(authorId: string, sinceMs: number, requestId?: string): Promise<number>;
}
