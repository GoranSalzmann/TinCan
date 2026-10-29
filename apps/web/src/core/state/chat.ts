// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import type { Message, ReadStateEntry } from "@tincan/shared";
import { api, ApiError, type UploadResult } from "../api/client.js";
import { useCommunity } from "./community.js";
import {
  appendNewer,
  applyCreate,
  applyDelete,
  applyPin,
  applyUpdate,
  fromAround,
  fromLatest,
  mentionsUser,
  mergeRead,
  prependOlder,
  type MessageWindow,
  type ReadInfo,
} from "./window.js";

/** Messages per page (07 §2.3 default). */
export const PAGE = 50;

/** A message the user sent that the server has not confirmed yet (12 §5.3 optimistic send). */
export interface PendingMessage {
  nonce: string;
  channelId: string;
  content: string;
  replyToId: string | undefined;
  attachments: UploadResult[];
  status: "sending" | "failed";
  error?: string;
  createdAt: number;
}

interface ChatState {
  windows: Record<string, MessageWindow>;
  loading: Record<string, boolean>;
  loadError: Record<string, string | undefined>;
  pending: Record<string, PendingMessage[]>;
  typing: Record<string, Record<string, number>>;
  read: Record<string, ReadInfo>;
  /** The message to scroll to and highlight after a jump (search result, reply reference). */
  focusId: string | null;

  open: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  loadNewer: (channelId: string) => Promise<void>;
  jumpTo: (channelId: string, messageId: string) => Promise<void>;
  jumpToLatest: (channelId: string) => Promise<void>;
  send: (
    channelId: string,
    input: { content: string; replyToId?: string; attachments?: UploadResult[]; nonce?: string },
  ) => Promise<void>;
  retry: (channelId: string, nonce: string) => Promise<void>;
  discard: (channelId: string, nonce: string) => void;
  clearFocus: () => void;
  setRead: (channelId: string, info: ReadInfo) => void;
  markRead: (channelId: string) => void;
  apply: (t: string, d: unknown) => void;
  reset: () => void;
}

const nonceOf = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const initial = {
  windows: {} as Record<string, MessageWindow>,
  loading: {} as Record<string, boolean>,
  loadError: {} as Record<string, string | undefined>,
  pending: {} as Record<string, PendingMessage[]>,
  typing: {} as Record<string, Record<string, number>>,
  read: {} as Record<string, ReadInfo>,
  focusId: null as string | null,
};

let ackTimer: ReturnType<typeof setTimeout> | undefined;
const ackQueue = new Set<string>();

export const useChat = create<ChatState>((set, get) => {
  const setWindow = (channelId: string, w: MessageWindow) =>
    set((s) => ({ windows: { ...s.windows, [channelId]: w } }));
  const setLoading = (channelId: string, v: boolean) =>
    set((s) => ({ loading: { ...s.loading, [channelId]: v } }));
  const fail = (channelId: string, e: unknown) =>
    set((s) => ({
      loadError: {
        ...s.loadError,
        [channelId]: e instanceof ApiError ? e.message : "Couldn't load messages.",
      },
    }));

  return {
    ...initial,
    reset: () => set({ ...initial }),
    clearFocus: () => set({ focusId: null }),

    async open(channelId) {
      set((s) => ({ loadError: { ...s.loadError, [channelId]: undefined } }));
      const have = get().windows[channelId];
      setLoading(channelId, true);
      try {
        const page = await api.history(channelId, { limit: PAGE });
        // Keep what is already loaded when the live edge is contiguous with it; otherwise start from the latest page.
        const latest = fromLatest(page, PAGE);
        const keep = have && !have.hasNewer && have.messages.length > 0;
        setWindow(channelId, keep ? { ...appendNewer(have, page, PAGE), hasNewer: false } : latest);
      } catch (e) {
        fail(channelId, e);
      } finally {
        setLoading(channelId, false);
      }
    },

    async loadOlder(channelId) {
      const w = get().windows[channelId];
      if (!w || !w.hasOlder || get().loading[channelId] || w.messages.length === 0) return;
      setLoading(channelId, true);
      try {
        const page = await api.history(channelId, { before: w.messages[0]!.id, limit: PAGE });
        setWindow(channelId, prependOlder(get().windows[channelId] ?? w, page, PAGE));
      } catch (e) {
        fail(channelId, e);
      } finally {
        setLoading(channelId, false);
      }
    },

    async loadNewer(channelId) {
      const w = get().windows[channelId];
      if (!w || !w.hasNewer || get().loading[channelId] || w.messages.length === 0) return;
      setLoading(channelId, true);
      try {
        const page = await api.history(channelId, {
          after: w.messages[w.messages.length - 1]!.id,
          limit: PAGE,
        });
        setWindow(channelId, appendNewer(get().windows[channelId] ?? w, page, PAGE));
      } catch (e) {
        fail(channelId, e);
      } finally {
        setLoading(channelId, false);
      }
    },

    async jumpTo(channelId, messageId) {
      const w = get().windows[channelId];
      if (w?.messages.some((m) => m.id === messageId)) {
        set({ focusId: messageId });
        return;
      }
      setLoading(channelId, true);
      try {
        const page = await api.history(channelId, { around: messageId, limit: PAGE });
        setWindow(channelId, fromAround(page, PAGE, messageId));
        set({ focusId: messageId });
      } catch (e) {
        fail(channelId, e);
      } finally {
        setLoading(channelId, false);
      }
    },

    async jumpToLatest(channelId) {
      setLoading(channelId, true);
      try {
        setWindow(channelId, fromLatest(await api.history(channelId, { limit: PAGE }), PAGE));
      } catch (e) {
        fail(channelId, e);
      } finally {
        setLoading(channelId, false);
      }
    },

    async send(channelId, input) {
      const nonce = input.nonce ?? nonceOf();
      const entry: PendingMessage = {
        nonce,
        channelId,
        content: input.content,
        replyToId: input.replyToId,
        attachments: input.attachments ?? [],
        status: "sending",
        createdAt: Date.now(),
      };
      set((s) => ({
        pending: {
          ...s.pending,
          [channelId]: [...(s.pending[channelId] ?? []).filter((p) => p.nonce !== nonce), entry],
        },
      }));
      try {
        const m = await api.sendMessage(channelId, {
          content: input.content,
          nonce,
          ...(input.replyToId ? { replyToId: input.replyToId } : {}),
          ...(entry.attachments.length ? { attachmentIds: entry.attachments.map((a) => a.id) } : {}),
        });
        // The REST answer and the MESSAGE_CREATE event may arrive in either order; both apply idempotently.
        get().apply("MESSAGE_CREATE", { message: m });
      } catch (e) {
        const message =
          e instanceof ApiError
            ? e.code === "RATE_LIMITED"
              ? "You're sending too fast."
              : e.message
            : "Couldn't send.";
        set((s) => ({
          pending: {
            ...s.pending,
            [channelId]: (s.pending[channelId] ?? []).map((p) =>
              p.nonce === nonce ? { ...p, status: "failed", error: message } : p,
            ),
          },
        }));
      }
    },

    async retry(channelId, nonce) {
      const p = get().pending[channelId]?.find((x) => x.nonce === nonce);
      if (!p) return;
      // Same nonce: if the first attempt did land, the server returns that message instead of a duplicate (07 §1).
      await get().send(channelId, {
        content: p.content,
        nonce,
        attachments: p.attachments,
        ...(p.replyToId ? { replyToId: p.replyToId } : {}),
      });
    },

    discard(channelId, nonce) {
      set((s) => ({
        pending: { ...s.pending, [channelId]: (s.pending[channelId] ?? []).filter((p) => p.nonce !== nonce) },
      }));
    },

    setRead(channelId, info) {
      set((s) => ({ read: { ...s.read, [channelId]: mergeRead(s.read[channelId], info) } }));
    },

    /** The channel is on screen, the window is focused and the user is at the bottom: tell the server (throttled). */
    markRead(channelId) {
      const r = get().read[channelId];
      const w = get().windows[channelId];
      const latest = w && !w.hasNewer ? w.messages[w.messages.length - 1]?.id : r?.latestMessageId;
      const newest = latest ?? r?.latestMessageId;
      if (!newest) return;
      if (r && r.lastReadId !== null && r.lastReadId >= newest && r.mentionCount === 0) return;
      get().setRead(channelId, {
        lastReadId: newest,
        latestMessageId: r?.latestMessageId && r.latestMessageId > newest ? r.latestMessageId : newest,
        mentionCount: 0,
      });
      ackQueue.add(channelId);
      clearTimeout(ackTimer);
      ackTimer = setTimeout(() => {
        for (const id of ackQueue) {
          const lastRead = get().read[id]?.lastReadId;
          if (lastRead) void api.ack(id, lastRead).catch(() => undefined);
        }
        ackQueue.clear();
      }, 800);
    },

    apply(t, d) {
      const p = d as Record<string, unknown>;
      switch (t) {
        case "READY": {
          const entries = (p.readState ?? []) as ReadStateEntry[];
          set((s) => {
            const read = { ...s.read };
            for (const e of entries) {
              read[e.channelId] = mergeRead(s.read[e.channelId], e);
            }
            return { read };
          });
          return;
        }
        case "READ_STATE_UPDATE": {
          const e = p as unknown as ReadStateEntry;
          get().setRead(e.channelId, e);
          return;
        }
        case "MESSAGE_CREATE": {
          const m = p.message as Message;
          const state = get();
          const me = useCommunity.getState();
          set((s) => {
            const w = s.windows[m.channelId];
            const pend = s.pending[m.channelId];
            return {
              ...(w ? { windows: { ...s.windows, [m.channelId]: applyCreate(w, m) } } : {}),
              ...(pend && m.nonce
                ? { pending: { ...s.pending, [m.channelId]: pend.filter((x) => x.nonce !== m.nonce) } }
                : {}),
              // The author stopped typing the moment the message arrived.
              typing: removeTyping(s.typing, m.channelId, m.authorId),
            };
          });
          // Unread bookkeeping (12 §5.4): our own messages never count; a mention bumps the badge.
          const selfId = selfIdOf();
          if (m.authorId !== selfId) {
            const cur = state.read[m.channelId];
            const mine = selfId ? (me.members[selfId]?.roleIds ?? []) : [];
            const counted = selfId ? mentionsUser(m, selfId, mine) : false;
            if (!cur || !cur.latestMessageId || m.id > cur.latestMessageId) {
              get().setRead(m.channelId, {
                lastReadId: cur?.lastReadId ?? null,
                latestMessageId: m.id,
                mentionCount: (cur?.mentionCount ?? 0) + (counted ? 1 : 0),
              });
            }
          }
          return;
        }
        case "MESSAGE_UPDATE": {
          const m = p.message as Message;
          set((s) => {
            const w = s.windows[m.channelId];
            return w ? { windows: { ...s.windows, [m.channelId]: applyUpdate(w, m) } } : {};
          });
          return;
        }
        case "MESSAGE_DELETE": {
          const channelId = p.channelId as string;
          set((s) => {
            const w = s.windows[channelId];
            return w ? { windows: { ...s.windows, [channelId]: applyDelete(w, p.messageId as string) } } : {};
          });
          return;
        }
        case "MESSAGE_PIN": {
          const channelId = p.channelId as string;
          set((s) => {
            const w = s.windows[channelId];
            return w
              ? {
                  windows: {
                    ...s.windows,
                    [channelId]: applyPin(w, p.messageId as string, p.pinned === true),
                  },
                }
              : {};
          });
          return;
        }
        case "TYPING_START": {
          const channelId = p.channelId as string;
          set((s) => ({
            typing: {
              ...s.typing,
              [channelId]: { ...(s.typing[channelId] ?? {}), [p.userId as string]: Date.now() + 8000 },
            },
          }));
          return;
        }
        case "CHANNEL_DELETE": {
          const id = p.channelId as string;
          set((s) => {
            const windows = { ...s.windows };
            delete windows[id];
            return { windows };
          });
          return;
        }
      }
    },
  };
});

function removeTyping(
  typing: Record<string, Record<string, number>>,
  channelId: string,
  userId: string,
): Record<string, Record<string, number>> {
  const cur = typing[channelId];
  if (!cur || !(userId in cur)) return typing;
  const next = { ...cur };
  delete next[userId];
  return { ...typing, [channelId]: next };
}

let selfId: string | null = null;
/** Set by the session store when the user is known. */
export function setSelfId(id: string | null): void {
  selfId = id;
}
function selfIdOf(): string | null {
  return selfId;
}
