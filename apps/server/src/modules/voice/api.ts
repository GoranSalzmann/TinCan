// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VoiceParticipant } from "@tincan/shared";
import type { VoiceStats } from "./service.js";

/** What `voice` offers other modules (04 §5): who is in a room, and the numbers the metrics module will export. */
export interface VoiceApi {
  participants(channelId: string): VoiceParticipant[];
  stats(): VoiceStats;
  /** Runs one reconciliation pass now (tests, `tincan doctor`). */
  reconcileNow(): Promise<void>;
}
