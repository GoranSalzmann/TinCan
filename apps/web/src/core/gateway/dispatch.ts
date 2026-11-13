// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "@tincan/shared";
import { shouldNotify, showNotification } from "../notifications.js";
import { playSfx } from "../sfx/sfx.js";
import { useChat } from "../state/chat.js";
import { memberName, useCommunity } from "../state/community.js";
import { mentionsUser } from "../state/window.js";
import { useUi } from "../state/ui.js";
import { useVoice } from "../voice/store.js";

let selfId: string | null = null;
export function setDispatchSelf(id: string | null): void {
  selfId = id;
}

/** Routes one gateway event to the stores (12 §5.2). Handlers are idempotent (07 §5). */
export function dispatchEvent(t: string, d: unknown): void {
  const peers = t === "VOICE_STATE_UPDATE" ? peersInMyCall() : null;
  useCommunity.getState().apply(t, d);
  useChat.getState().apply(t, d);
  useVoice.getState().apply(t, d);
  if (peers) peerSounds(peers, peersInMyCall());
  if (t === "READY") useUi.getState().bumpReady();
  if (t === "MESSAGE_CREATE") notify((d as { message: Message }).message);
}

/** Others in the voice channel this client is in, or null when not in a call. */
function peersInMyCall(): Set<string> | null {
  const v = useVoice.getState();
  if (!v.channelId || v.status !== "connected") return null;
  return new Set((v.presence[v.channelId] ?? []).map((p) => p.userId).filter((id) => id !== selfId));
}

/** A cue when someone enters or leaves the call (also when they switch to another room). */
function peerSounds(before: Set<string> | null, after: Set<string> | null): void {
  if (!before || !after) return;
  if ([...after].some((id) => !before.has(id))) playSfx("peerJoin");
  else if ([...before].some((id) => !after.has(id))) playSfx("peerLeave");
}

function notify(m: Message): void {
  if (!selfId) return;
  const community = useCommunity.getState();
  const ui = useUi.getState();
  if (
    !shouldNotify({
      message: m,
      selfId,
      selfRoleIds: community.members[selfId]?.roleIds ?? [],
      settings: community.settings,
      windowFocused: ui.windowFocused,
      selectedChannelId: ui.selectedChannelId,
      now: Date.now(),
    })
  )
    return;
  playSfx(mentionsUser(m, selfId, community.members[selfId]?.roleIds ?? []) ? "mention" : "message");
  const channel = community.channels.find((c) => c.id === m.channelId);
  const author = memberName(community.members[m.authorId], m.author?.displayName ?? "Someone");
  showNotification({
    title: `${author} in #${channel?.name ?? "channel"}`,
    // Mention tokens are IDs; the notification shows plain text.
    body:
      m.content
        .replace(/<@&?[0-9A-Z]{26}>/g, "@…")
        .replace(/<#[0-9A-Z]{26}>/g, "#…")
        .slice(0, 140) || "Sent a file",
    tag: m.channelId,
    onClick: () => ui.navigator?.(m.channelId, m.id),
  });
}
