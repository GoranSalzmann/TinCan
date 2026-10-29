// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "@tincan/shared";

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
  /** Live messages after `afterId` in ID order, for `search reindex`. */
  documents(afterId: string | null, limit: number): Promise<SearchDocument[]>;
  /** The text that goes into the search index for a message. */
  searchText(content: string): string;
}
