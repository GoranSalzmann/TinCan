// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
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
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationPermission();
  }
}

/**
 * Keeps the permission state live and never leaves it stuck at "default": until the user explicitly
 * grants or denies, the next click or key press asks again (browsers only show the prompt from a user
 * gesture). The state is re-read on focus, visibility change, the Permissions API change event and a
 * slow timer, so a change made in the browser's site settings is picked up without a reload.
 */
export function watchNotificationPermission(onChange: (p: PermissionState) => void): () => void {
  if (typeof Notification === "undefined") {
    onChange("unsupported");
    return () => undefined;
  }
  let inflight = false;
  const sync = () => onChange(notificationPermission());
  const ask = () => {
    if (inflight || notificationPermission() !== "default") return;
    inflight = true;
    void requestNotificationPermission().finally(() => {
      inflight = false;
      sync();
    });
  };
  sync();
  document.addEventListener("pointerdown", ask, true);
  document.addEventListener("keydown", ask, true);
  window.addEventListener("focus", sync);
  document.addEventListener("visibilitychange", sync);
  const timer = window.setInterval(sync, 5000);
  let status: PermissionStatus | null = null;
  let disposed = false;
  navigator.permissions
    ?.query({ name: "notifications" })
    .then((st) => {
      if (disposed) return;
      status = st;
      st.onchange = sync;
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    document.removeEventListener("pointerdown", ask, true);
    document.removeEventListener("keydown", ask, true);
    window.removeEventListener("focus", sync);
    document.removeEventListener("visibilitychange", sync);
    window.clearInterval(timer);
    if (status) status.onchange = null;
  };
}

export function useNotificationPermission(): PermissionState {
  const [perm, setPerm] = useState<PermissionState>(notificationPermission());
  useEffect(() => watchNotificationPermission(setPerm), []);
  return perm;
}

export interface NotificationClickMessage {
  type: "notification-click";
  channelId: string;
  messageId?: string;
}

/**
 * Shows a notification. Goes through the service worker when one is active (works while the tab is in
 * the background and on mobile, where the constructor is refused), else the plain constructor.
 */
export function showNotification(opts: {
  title: string;
  body: string;
  tag: string;
  channelId: string;
  messageId?: string;
  onClick: () => void;
}): void {
  if (notificationPermission() !== "granted") return;
  const options = {
    body: opts.body,
    tag: opts.tag,
    icon: "/icons/icon-192.png",
    data: { channelId: opts.channelId, messageId: opts.messageId },
  };
  const direct = () => {
    try {
      const n = new Notification(opts.title, options);
      n.onclick = () => {
        window.focus();
        opts.onClick();
        n.close();
      };
    } catch {
      // Nothing more to try.
    }
  };
  const sw = navigator.serviceWorker;
  if (!sw?.controller) return direct();
  sw.ready.then((reg) => reg.showNotification(opts.title, options)).catch(direct);
}

/** Opens the channel when a notification shown by the service worker is clicked. */
export function listenForNotificationClicks(
  open: (channelId: string, messageId?: string) => void,
  resubscribe?: () => void,
): () => void {
  const sw = navigator.serviceWorker;
  if (!sw) return () => undefined;
  const handler = (e: MessageEvent) => {
    const d = e.data as NotificationClickMessage | undefined;
    if (d?.type === "notification-click") open(d.channelId, d.messageId);
    else if ((e.data as { type?: string } | undefined)?.type === "push-resubscribe") resubscribe?.();
  };
  sw.addEventListener("message", handler);
  return () => sw.removeEventListener("message", handler);
}
