// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "@tincan/db";
import type { Attachment } from "@tincan/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the caller's transaction, narrowed here
type AnyDb = Db<any>;

/** What `uploads` offers other modules (04 §5): attaching uploads to messages and reading them back. */
export interface UploadsApi {
  /**
   * Inside the message transaction: checks every ID is the uploader's own, unattached, not removed,
   * then attaches them. Throws VALIDATION_FAILED otherwise.
   */
  attach(
    tx: AnyDb,
    args: { ids: string[]; uploaderId: string; messageId: string; channelId: string },
  ): Promise<void>;
  /** Attachments grouped by message, in upload order. Removed ones are included with `removed: true`. */
  forMessages(messageIds: readonly string[]): Promise<Map<string, Attachment[]>>;
}
