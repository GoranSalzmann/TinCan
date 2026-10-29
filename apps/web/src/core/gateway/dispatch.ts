// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "@tincan/shared";
import { shouldNotify, showNotification } from "../notifications.js";
import { useChat } from "../state/chat.js";
import { memberName, useCommunity } from "../state/community.js";
import { useUi } from "../state/ui.js";

let selfId: string | null = null;
export function setDispatchSelf(id: string | null): void {
  selfId = id;
}

/** Routes one gateway event to the stores (12 §5.2). Handlers are idempotent (07 §5). */
export function dispatchEvent(t: string, d: unknown): void {
  useCommunity.getState().apply(t, d);
  useChat.getState().apply(t, d);
  if (t === "READY") useUi.getState().bumpReady();
  if (t === "MESSAGE_CREATE") notify((d as { message: Message }).message);
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
