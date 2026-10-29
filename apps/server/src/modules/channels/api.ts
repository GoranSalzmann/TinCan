// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ChannelKind } from "@tincan/shared";

export interface ChannelRecord {
  id: string;
  categoryId: string | null;
  type: ChannelKind;
  name: string;
  topic: string | null;
  position: number;
  createdAt: number;
  archivedAt: number | null;
  settings: { slowmodeSecs?: number };
}

/** What `channels` offers other modules (04 §5). */
export interface ChannelsApi {
  get(id: string): Promise<ChannelRecord | null>;
  list(): Promise<ChannelRecord[]>;
}
