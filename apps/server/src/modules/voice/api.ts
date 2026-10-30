// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VoiceParticipant } from "@tincan/shared";
import type { VoiceStats } from "./service.js";

/** What `voice` offers other modules (04 §5): who is in a room, and the numbers the metrics module will export. */
export interface VoiceApi {
  participants(channelId: string): VoiceParticipant[];
  stats(): VoiceStats;
  /** Runs one reconciliation pass now (tests, `tincan doctor`). */
  reconcileNow(): Promise<void>;
  /** Server mute and deafen (11 §3): persists, applies to a live session and tells the room. */
  setServerState(
    userId: string,
    patch: { muted?: boolean | undefined; deafened?: boolean | undefined },
    by: string,
  ): Promise<{ muted: boolean; deafened: boolean }>;
  restrictionOf(userId: string): { muted: boolean; deafened: boolean };
  /** The voice channel a person is in right now, or null. */
  whereIs(userId: string): string | null;
  /** Sends a person out of voice; `to` makes their client join that channel. False when they were not in voice. */
  disconnect(
    userId: string,
    reason: "disconnected" | "kicked" | "moved_by_moderator",
    to?: string,
  ): Promise<boolean>;
  /** Throws when the person could not join `channelId` (not a voice channel, no CONNECT, full). */
  checkMoveTarget(userId: string, channelId: string): Promise<void>;
  rotateKey(channelId: string): Promise<void>;
  /** Number of people in each occupied voice room, for the metrics module. */
  occupancy(): number[];
}
