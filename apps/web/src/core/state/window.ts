// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "@tincan/shared";

/**
 * The pure logic behind a channel's message window (12 §5.3): a contiguous run of messages by ID,
 * with flags for whether older or newer ones exist on the server. Kept free of React and the network
 * so the gap, prepend and live-edge rules can be tested directly.
 */
export interface MessageWindow {
  /** Ascending by ID, no duplicates. */
  messages: Message[];
  /** Older messages exist on the server. */
  hasOlder: boolean;
  /** The window ends before the newest message, so live events must not be appended (they would leave a gap). */
  hasNewer: boolean;
}

export const EMPTY_WINDOW: MessageWindow = { messages: [], hasOlder: false, hasNewer: false };

/** At most this many messages stay in memory when the user is following the live edge. */
export const WINDOW_CAP = 600;

/** Merges by ID (the incoming copy wins, so edits replace), sorted. */
export function mergeMessages(existing: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The first page for a channel: the newest `limit` messages. */
export function fromLatest(page: readonly Message[], limit: number): MessageWindow {
  return { messages: mergeMessages([], page), hasOlder: page.length >= limit, hasNewer: false };
}

/** An `around` page replaces the window; both ends may continue. */
export function fromAround(page: readonly Message[], limit: number, aroundId: string): MessageWindow {
  const merged = mergeMessages([], page);
  const before = merged.filter((m) => m.id < aroundId).length;
  const after = merged.length - before;
  // `around` asks for half before and half from the target on; a short side means that end is reached.
  return {
    messages: merged,
    hasOlder: before >= Math.floor(limit / 2),
    hasNewer: after >= Math.ceil(limit / 2),
  };
}

export function prependOlder(w: MessageWindow, page: readonly Message[], limit: number): MessageWindow {
  return {
    messages: mergeMessages(w.messages, page),
    hasOlder: page.length >= limit,
    hasNewer: w.hasNewer,
  };
}

export function appendNewer(w: MessageWindow, page: readonly Message[], limit: number): MessageWindow {
  return {
    messages: mergeMessages(w.messages, page),
    hasOlder: w.hasOlder,
    hasNewer: page.length >= limit,
  };
}

/** A live MESSAGE_CREATE: appended when the window reaches the newest message, otherwise it only marks that there is more. */
export function applyCreate(w: MessageWindow, m: Message, following = true): MessageWindow {
  if (w.hasNewer) return w;
  if (w.messages.some((x) => x.id === m.id)) return { ...w, messages: mergeMessages(w.messages, [m]) };
  let messages = mergeMessages(w.messages, [m]);
  let hasOlder = w.hasOlder;
  if (following && messages.length > WINDOW_CAP) {
    messages = messages.slice(messages.length - WINDOW_CAP);
    hasOlder = true;
  }
  return { messages, hasOlder, hasNewer: false };
}

/** Edits are last-writer-wins by `editedAt` so an old event cannot undo a newer edit (07 §5). */
export function applyUpdate(w: MessageWindow, m: Message): MessageWindow {
  const i = w.messages.findIndex((x) => x.id === m.id);
  if (i < 0) return w;
  const cur = w.messages[i]!;
  if (cur.editedAt && m.editedAt && m.editedAt < cur.editedAt) return w;
  const messages = [...w.messages];
  messages[i] = { ...m, nonce: m.nonce ?? cur.nonce };
  return { ...w, messages };
}

export function applyDelete(w: MessageWindow, id: string): MessageWindow {
  if (!w.messages.some((m) => m.id === id)) return w;
  // Messages that replied to it keep a pointer; the reference shows as deleted.
  const messages = w.messages
    .filter((m) => m.id !== id)
    .map((m) => (m.reply?.id === id ? { ...m, reply: { ...m.reply, deleted: true, excerpt: "" } } : m));
  return { ...w, messages };
}

export function applyPin(w: MessageWindow, id: string, pinned: boolean): MessageWindow {
  return { ...w, messages: w.messages.map((m) => (m.id === id ? { ...m, pinned } : m)) };
}

// ---- read state ----------------------------------------------------------------------------------

export interface ReadInfo {
  lastReadId: string | null;
  latestMessageId: string | null;
  mentionCount: number;
}

/** A channel is unread when its newest message is newer than the read position (12 §5.4). */
export function isUnread(r: ReadInfo | undefined): boolean {
  return !!r?.latestMessageId && (r.lastReadId === null || r.latestMessageId > r.lastReadId);
}

/** Never moves backwards: an event from a slower device cannot un-read (06 §3.8). */
export function mergeRead(cur: ReadInfo | undefined, next: ReadInfo): ReadInfo {
  if (!cur) return next;
  const lastReadId =
    cur.lastReadId && (!next.lastReadId || cur.lastReadId > next.lastReadId)
      ? cur.lastReadId
      : next.lastReadId;
  const latestMessageId =
    cur.latestMessageId && (!next.latestMessageId || cur.latestMessageId > next.latestMessageId)
      ? cur.latestMessageId
      : next.latestMessageId;
  const stale = lastReadId !== next.lastReadId;
  return {
    lastReadId,
    latestMessageId,
    mentionCount: stale ? Math.min(cur.mentionCount, next.mentionCount) : next.mentionCount,
  };
}

/** The ID of the first unread message in the window, for the "new messages" divider. */
export function firstUnreadId(
  messages: readonly Message[],
  lastReadId: string | null,
  selfId: string,
): string | null {
  if (lastReadId === null) return null;
  const m = messages.find((x) => x.id > lastReadId && x.authorId !== selfId);
  return m?.id ?? null;
}

/** Whether a message mentions the user, directly, through a role, or with @everyone. */
export function mentionsUser(m: Message, userId: string, roleIds: readonly string[]): boolean {
  return (
    m.mentions.everyone ||
    m.mentions.users.includes(userId) ||
    m.mentions.roles.some((r) => roleIds.includes(r))
  );
}
