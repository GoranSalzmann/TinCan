// SPDX-License-Identifier: AGPL-3.0-or-later
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@tincan/shared";
import { useT } from "../../core/i18n/index.js";
import { useChat, type PendingMessage } from "../../core/state/chat.js";
import { useUi } from "../../core/state/ui.js";
import { firstUnreadId } from "../../core/state/window.js";
import { Button } from "../../ui/Button.js";
import { MessageItem, PendingItem } from "./MessageItem.js";

const GROUP_MS = 7 * 60_000;
const NEAR_BOTTOM_PX = 80;
const NEAR_TOP_PX = 300;
const day = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });

type Row =
  | { key: string; kind: "date"; label: string }
  | { key: string; kind: "unread" }
  | { key: string; kind: "message"; message: Message; grouped: boolean }
  | { key: string; kind: "pending"; pending: PendingMessage };

/** Date separators, the "new" divider and author grouping (comfortable density, W-03). */
export function buildRows(
  messages: readonly Message[],
  pending: readonly PendingMessage[],
  unreadFrom: string | null,
): Row[] {
  const rows: Row[] = [];
  let prev: Message | undefined;
  let prevDay = "";
  for (const m of messages) {
    const d = new Date(m.createdAt);
    const dayKey = d.toDateString();
    if (dayKey !== prevDay) {
      rows.push({ key: `d-${dayKey}`, kind: "date", label: day.format(d) });
      prevDay = dayKey;
      prev = undefined;
    }
    if (m.id === unreadFrom) {
      rows.push({ key: "unread", kind: "unread" });
      prev = undefined;
    }
    const grouped =
      !!prev &&
      prev.authorId === m.authorId &&
      !m.reply &&
      new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_MS;
    rows.push({ key: m.id, kind: "message", message: m, grouped });
    prev = m;
  }
  for (const p of pending) rows.push({ key: `p-${p.nonce}`, kind: "pending", pending: p });
  return rows;
}

export function MessageList({
  channelId,
  selfId,
  selfName,
  selfAvatar,
  perms,
  onReply,
}: {
  channelId: string;
  selfId: string;
  selfName: string;
  selfAvatar: string | null;
  perms: bigint;
  onReply: (m: Message) => void;
}) {
  const t = useT();
  const win = useChat((s) => s.windows[channelId]);
  const pending = useChat((s) => s.pending[channelId]);
  const loading = useChat((s) => s.loading[channelId] ?? false);
  const loadError = useChat((s) => s.loadError[channelId]);
  const focusId = useChat((s) => s.focusId);
  const readInfo = useChat((s) => s.read[channelId]);
  const { loadOlder, loadNewer, jumpTo, jumpToLatest, markRead, open, clearFocus } = useChat.getState();
  const windowFocused = useUi((s) => s.windowFocused);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [highlight, setHighlight] = useState<string | null>(null);

  // The divider marks where unread messages began when the channel was opened; it stays until you leave.
  const unreadFrom = useRef<{ channelId: string; id: string | null } | null>(null);
  if (unreadFrom.current?.channelId !== channelId) {
    unreadFrom.current = { channelId, id: readInfo?.lastReadId ?? null };
  }
  const messages = win?.messages;
  const dividerId = useMemo(
    () => (messages ? firstUnreadId(messages, unreadFrom.current?.id ?? null, selfId) : null),
    [messages, selfId, channelId],
  );

  const rows = useMemo(
    () => buildRows(messages ?? [], pending ?? [], dividerId),
    [messages, pending, dividerId],
  );

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "message" ? 56 : 32),
    overscan: 8,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  // ---- first paint of a channel: load, then sit at the bottom ----
  const justOpened = useRef(true);
  useEffect(() => {
    justOpened.current = true;
    atBottomRef.current = true;
    setAtBottom(true);
    void open(channelId);
  }, [channelId, open]);

  const readyCount = useUi((s) => s.readyCount);
  const firstReady = useRef(readyCount);
  useEffect(() => {
    // A new READY after a non-resumable reconnect: verify the live edge (12 §5.2), keep what is loaded.
    if (readyCount !== firstReady.current) {
      firstReady.current = readyCount;
      void open(channelId);
    }
  }, [readyCount, channelId, open]);

  useLayoutEffect(() => {
    if (justOpened.current && rows.length > 0) {
      virt.scrollToIndex(rows.length - 1, { align: "end" });
      justOpened.current = false;
    }
  }, [rows.length, virt]);

  // ---- keep following the live edge; preserve position when older pages arrive ----
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const lastCount = useRef(0);
  useLayoutEffect(() => {
    const grew = rows.length > lastCount.current;
    lastCount.current = rows.length;
    if (anchor.current) {
      const i = rows.findIndex((r) => r.key === anchor.current!.key);
      if (i >= 0) {
        const [offset] = virt.getOffsetForIndex(i, "start") ?? [0];
        scrollRef.current?.scrollTo({ top: offset - anchor.current.offset });
      }
      anchor.current = null;
      return;
    }
    if (grew && atBottomRef.current && !justOpened.current)
      virt.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows, virt]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    atBottomRef.current = bottom && !useChat.getState().windows[channelId]?.hasNewer;
    setAtBottom(atBottomRef.current);
    if (el.scrollTop < NEAR_TOP_PX && !justOpened.current) {
      const first = virt.getVirtualItems()[0];
      if (first && rows[first.index])
        anchor.current = { key: rows[first.index]!.key, offset: first.start - el.scrollTop };
      void loadOlder(channelId);
    }
    if (bottom && useChat.getState().windows[channelId]?.hasNewer) void loadNewer(channelId);
  }, [channelId, loadNewer, loadOlder, rows, virt]);

  // ---- reading the channel: on screen, window focused, at the bottom (12 §5.4) ----
  useEffect(() => {
    if (
      atBottom &&
      windowFocused &&
      document.visibilityState !== "hidden" &&
      messages &&
      messages.length > 0
    ) {
      markRead(channelId);
    }
  }, [atBottom, windowFocused, channelId, messages, markRead]);

  // ---- jump to a message (search result, reply reference) ----
  useEffect(() => {
    if (!focusId || !messages) return;
    const i = rows.findIndex((r) => r.key === focusId);
    if (i < 0) return;
    virt.scrollToIndex(i, { align: "center" });
    setHighlight(focusId);
    clearFocus();
    const timer = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(timer);
  }, [focusId, rows, messages, virt, clearFocus]);

  if (!win) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-text-muted" role="status">
        {loadError ? (
          <div className="flex flex-col items-center gap-2">
            <p>{loadError}</p>
            <Button onClick={() => void open(channelId)}>{t("connect.failed.retry")}</Button>
          </div>
        ) : (
          t("app.loading")
        )}
      </div>
    );
  }

  const empty = win.messages.length === 0 && !win.hasOlder && (pending?.length ?? 0) === 0;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="feed"
        aria-busy={loading}
        aria-label={t("message.feed")}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {win.hasOlder ? (
          <div className="p-2 text-center text-sm text-text-muted" role="status">
            {loading ? (
              t("message.loadingOlder")
            ) : (
              <button type="button" onClick={() => void loadOlder(channelId)}>
                {t("message.loadOlder")}
              </button>
            )}
          </div>
        ) : null}
        {empty ? (
          <div className="p-6">
            <h2 className="text-2xl">{t("message.empty.title")}</h2>
            <p className="text-text-muted">{t("message.empty.body")}</p>
          </div>
        ) : null}
        <div style={{ height: virt.getTotalSize(), position: "relative", width: "100%" }}>
          {virt.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virt.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === "date" ? (
                  <div className="my-2 flex items-center gap-3 px-4 text-xs text-text-muted" role="separator">
                    <span className="h-px flex-1 bg-border" />
                    {row.label}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                ) : row.kind === "unread" ? (
                  <div
                    className="my-1 flex items-center gap-3 px-4 text-xs font-semibold text-danger-text"
                    role="separator"
                  >
                    <span className="h-px flex-1 bg-danger" />
                    {t("message.new")}
                    <span className="h-px flex-1 bg-danger" />
                  </div>
                ) : row.kind === "message" ? (
                  <MessageItem
                    message={row.message}
                    grouped={row.grouped}
                    highlight={highlight === row.message.id}
                    selfId={selfId}
                    perms={perms}
                    onReply={onReply}
                    onJump={(id) => void jumpTo(channelId, id)}
                  />
                ) : (
                  <PendingItem p={row.pending} selfName={selfName} selfAvatar={selfAvatar} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!atBottom || win.hasNewer ? (
        <Button
          onClick={() => {
            if (win.hasNewer) void jumpToLatest(channelId);
            else virt.scrollToIndex(rows.length - 1, { align: "end" });
            atBottomRef.current = true;
            setAtBottom(true);
          }}
          className="absolute end-4 bottom-3 shadow-md"
        >
          <ArrowDown aria-hidden="true" size={16} />
          {readInfo && readInfo.mentionCount > 0
            ? t("message.jumpLatest.mentions", { count: readInfo.mentionCount })
            : t("message.jumpLatest")}
        </Button>
      ) : null}
    </div>
  );
}
