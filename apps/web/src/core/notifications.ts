// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message, NotificationLevel } from "@tincan/shared";
import { mentionsUser } from "./state/window.js";

/**
 * Web notifications (12 §5.4). Rules come from the synced settings: a default level, per-channel
 * overrides and timed mutes. A muted channel still notifies for mentions (W-02). Web Push is not in v1,
 * so these fire only while a tab is open.
 */

export interface ChannelPref {
  level?: NotificationLevel;
  mutedUntil?: number | null;
}

export function levelFor(
  settings: Record<string, unknown>,
  channelId: string,
  now: number,
): { level: NotificationLevel; muted: boolean } {
  const fallback = (settings["notifications.default"] as NotificationLevel | undefined) ?? "all";
  const pref = settings[`notifications.channel.${channelId}`] as ChannelPref | undefined;
  const muted = !!pref?.mutedUntil && pref.mutedUntil > now;
  // Muted channels show mentions only.
  const level = muted ? "mentions" : (pref?.level ?? fallback);
  return { level, muted };
}

export interface NotifyInput {
  message: Message;
  selfId: string;
  selfRoleIds: readonly string[];
  settings: Record<string, unknown>;
  windowFocused: boolean;
  selectedChannelId: string | null;
  now: number;
}

/** Whether a new message should raise a desktop notification. */
export function shouldNotify(i: NotifyInput): boolean {
  const { message: m } = i;
  if (m.authorId === i.selfId) return false;
  // Looking at the channel in a focused window: nothing to announce.
  if (i.windowFocused && i.selectedChannelId === m.channelId) return false;
  const { level } = levelFor(i.settings, m.channelId, i.now);
  if (level === "none") return false;
  if (level === "mentions") return mentionsUser(m, i.selfId, i.selfRoleIds);
  return true;
}

/** Whether a channel counts towards the page title badge: unread and not muted, or mentioned. */
export function badgeCount(
  read: Record<string, { lastReadId: string | null; latestMessageId: string | null; mentionCount: number }>,
  settings: Record<string, unknown>,
  now: number,
): { mentions: number; unread: boolean } {
  let mentions = 0;
  let unread = false;
  for (const [id, r] of Object.entries(read)) {
    mentions += r.mentionCount;
    const { level, muted } = levelFor(settings, id, now);
    if (
      !muted &&
      level !== "none" &&
      r.latestMessageId &&
      (r.lastReadId === null || r.latestMessageId > r.lastReadId)
    )
      unread = true;
  }
  return { mentions, unread };
}

export type PermissionState = "granted" | "denied" | "default" | "unsupported";

export function notificationPermission(): PermissionState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export async function requestNotificationPermission(): Promise<PermissionState> {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.requestPermission();
}

export function showNotification(opts: {
  title: string;
  body: string;
  tag: string;
  onClick: () => void;
}): void {
  if (notificationPermission() !== "granted") return;
  try {
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag });
    n.onclick = () => {
      window.focus();
      opts.onClick();
      n.close();
    };
  } catch {
    // Some browsers refuse the constructor outside a service worker (mobile); nothing to do.
  }
}
