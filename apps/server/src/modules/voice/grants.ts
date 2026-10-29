// SPDX-License-Identifier: AGPL-3.0-or-later
import { has, type ChannelSettings, type VoiceSource } from "@tincan/shared";
import type { LkPermission } from "./livekit.js";

/**
 * Tin Can permissions → LiveKit grant (08 §8). Pure, so the authorisation tests can run it table-driven.
 * Server-side actions (mute, move) are never part of a client token.
 */
export function grantFor(perms: bigint, settings: ChannelSettings): LkPermission {
  if (!has(perms, "CONNECT")) return { canSubscribe: false, canPublish: false, sources: [] };
  const sources: VoiceSource[] = [];
  if (has(perms, "SPEAK")) sources.push("microphone");
  if (has(perms, "VIDEO") && settings.videoAllowed !== false) sources.push("camera");
  if (has(perms, "SCREEN_SHARE") && settings.screenshareAllowed !== false) {
    sources.push("screen_share", "screen_share_audio");
  }
  return { canSubscribe: true, canPublish: sources.length > 0, sources };
}

export function samePermission(a: LkPermission, b: LkPermission): boolean {
  if (a.canSubscribe !== b.canSubscribe || a.canPublish !== b.canPublish) return false;
  const x = [...a.sources].sort().join(",");
  const y = [...b.sources].sort().join(",");
  return x === y;
}
