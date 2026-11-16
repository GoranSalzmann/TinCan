// SPDX-License-Identifier: AGPL-3.0-or-later
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
/** Within this distance of the end counts as following it. */
const NEAR_BOTTOM_PX = 80;
/** Fetch the next page while at least this much (or 1.5 screens) is still left before an edge. */
const PREFETCH_MIN_PX = 1200;
/** Pause automatic paging this long after a failed page. */
const RETRY_MS = 3000;
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

/**
 * The message feed. Scrolling is anchored to the newest message, with three layers so it holds on
 * any channel length and any mix of row heights (images, previews and code blocks size themselves late):
 *
 * 1. The scroller is `flex-direction: column-reverse` around one content block, so the browser's
 *    scroll origin is the bottom. A fresh channel paints at its newest message with no script, and
 *    rows growing above the viewport (older pages, late images) never move what is on screen.
 * 2. After every change of rows or of size (ResizeObserver), the position is settled before paint:
 *    pinned to the end while following the live edge, otherwise the top visible row is held exactly
 *    where it was.
 * 3. Paging is driven by distance from each edge, measured after every scroll and every settle, so a
 *    short page simply leads to the next until the screen is full. The loaded window is capped
 *    (WINDOW_CAP), trimming the end the reader moves away from, so the DOM stays small.
 */
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
  const contentRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  /** Following the newest message: every change ends at the bottom. Cleared only by scrolling away. */
  const pinned = useRef(true);
  /** "Jump to latest" (or sending) asked for the end; honoured once the live edge is loaded. */
  const wantLatest = useRef(false);
  /** The top visible row and its viewport position, held still while not pinned. */
  const anchor = useRef<{ key: string; top: number } | null>(null);
  /** After a failed page, automatic paging waits a moment instead of retrying on every scroll event. */
  const retryAt = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
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

  // ---- geometry ----

  /** How much content lies beyond each edge of the viewport (direction-agnostic: measured with rects). */
  const edges = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return null;
    const view = el.getBoundingClientRect();
    const box = content.getBoundingClientRect();
    return { el, viewTop: view.top, fromTop: view.top - box.top, fromBottom: box.bottom - view.bottom };
  }, []);

  const rowNode = useCallback((key: string): HTMLElement | null => {
    for (const n of rowsRef.current?.children ?? []) {
      if ((n as HTMLElement).dataset.key === key) return n as HTMLElement;
    }
    return null;
  }, []);

  /** Remember the first row whose bottom is below the top of the viewport (binary search: rows are in order). */
  const captureAnchor = useCallback(() => {
    const g = edges();
    const kids = rowsRef.current?.children;
    if (!g || !kids || kids.length === 0) {
      anchor.current = null;
      return;
    }
    let lo = 0;
    let hi = kids.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid]!.getBoundingClientRect().bottom > g.viewTop) hi = mid;
      else lo = mid + 1;
    }
    const n = kids[lo] as HTMLElement;
    anchor.current = { key: n.dataset.key ?? "", top: n.getBoundingClientRect().top };
  }, [edges]);

  const maybeLoad = useCallback(() => {
    const g = edges();
    const s = useChat.getState();
    const w = s.windows[channelId];
    if (!g || !w || w.messages.length === 0 || s.loading[channelId] || Date.now() < retryAt.current) return;
    const ahead = Math.max(PREFETCH_MIN_PX, g.el.clientHeight * 1.5);
    if (w.hasOlder && g.fromTop < ahead) void loadOlder(channelId);
    else if (w.hasNewer && g.fromBottom < ahead) void loadNewer(channelId);
  }, [channelId, edges, loadOlder, loadNewer]);

  /** Put the view where it belongs after anything changed: the end when following, else the anchor row where it was. */
  const settle = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const live = !useChat.getState().windows[channelId]?.hasNewer;
    if (live && wantLatest.current) {
      wantLatest.current = false;
      pinned.current = true;
      setAtBottom(true);
    }
    if (pinned.current && live) {
      // Past the end clamps to the end, whichever way the scroll origin runs.
      el.scrollTop = el.scrollHeight;
    } else if (anchor.current) {
      const n = rowNode(anchor.current.key);
      if (n) {
        const delta = n.getBoundingClientRect().top - anchor.current.top;
        if (Math.abs(delta) >= 0.5) el.scrollTop += delta;
      }
    }
    captureAnchor();
    maybeLoad();
  }, [channelId, rowNode, captureAnchor, maybeLoad]);

  const onScroll = useCallback(() => {
    const g = edges();
    if (!g) return;
    const bottom = g.fromBottom < NEAR_BOTTOM_PX && !useChat.getState().windows[channelId]?.hasNewer;
    pinned.current = bottom;
    setAtBottom(bottom);
    captureAnchor();
    maybeLoad();
  }, [channelId, edges, captureAnchor, maybeLoad]);

  // ---- loading ----

  useEffect(() => {
    void open(channelId);
  }, [channelId, open]);

  const readyCount = useUi((s) => s.readyCount);
  const firstReady = useRef(readyCount);
  useEffect(() => {
    // A new READY after a non-resumable reconnect: verify the live edge (12 §5.2), keep what is loaded.
    if (readyCount !== firstReady.current) {
      firstReady.current = readyCount;
      void open(channelId, { resume: true });
    }
  }, [readyCount, channelId, open]);

  useEffect(() => {
    if (loadError) retryAt.current = Date.now() + RETRY_MS;
  }, [loadError]);

  // ---- jump to a message (search result, reply reference): before the settle below, same commit ----
  useLayoutEffect(() => {
    if (!focusId) return;
    const n = rowNode(focusId);
    if (!n) return;
    n.scrollIntoView({ block: "center" });
    pinned.current = false;
    wantLatest.current = false;
    setAtBottom(false);
    anchor.current = { key: focusId, top: n.getBoundingClientRect().top };
    setHighlight(focusId);
    clearFocus();
  }, [focusId, rows, rowNode, clearFocus]);

  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(timer);
  }, [highlight]);

  // ---- sending your own message always brings you to the newest ----
  const pendingCount = pending?.length ?? 0;
  const lastPending = useRef(pendingCount);
  useLayoutEffect(() => {
    const grew = pendingCount > lastPending.current;
    lastPending.current = pendingCount;
    if (!grew) return;
    wantLatest.current = true;
    if (useChat.getState().windows[channelId]?.hasNewer) void jumpToLatest(channelId);
  }, [pendingCount, channelId, jumpToLatest]);

  // ---- every change of rows settles before paint ----
  // The anchor must describe the view the instant before the rows change: a scroll can land after the
  // last scroll event was handled, and restoring an older snapshot would undo it. Store updates
  // render synchronously, so measuring here is measuring right before the commit.
  useEffect(
    () =>
      useChat.subscribe((s, prev) => {
        if (
          s.windows[channelId] !== prev.windows[channelId] ||
          s.pending[channelId] !== prev.pending[channelId]
        )
          captureAnchor();
      }),
    [channelId, captureAnchor],
  );
  useLayoutEffect(() => {
    settle();
  }, [rows, settle]);

  // ---- and so does every change of size: late images, previews, a resized window or composer ----
  const hasWindow = !!win;
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => settle());
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, [hasWindow, settle]);

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

  const onJump = useCallback((id: string) => void jumpTo(channelId, id), [channelId, jumpTo]);

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
        className="flex min-h-0 flex-1 flex-col-reverse overflow-x-hidden overflow-y-auto"
      >
        {/* One block inside the reversed scroller: the scroll origin is the bottom, the reading order is unchanged. */}
        <div ref={contentRef} className="shrink-0 pb-2">
          {win.hasOlder ? (
            <div className="p-2 text-center text-sm text-text-muted" role="status">
              {loading ? (
                t("message.loadingOlder")
              ) : loadError ? (
                <span className="inline-flex items-center gap-2">
                  {loadError}
                  <button type="button" className="underline" onClick={() => void loadOlder(channelId)}>
                    {t("connect.failed.retry")}
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => void loadOlder(channelId)}>
                  {t("message.loadOlder")}
                </button>
              )}
            </div>
          ) : null}
          {empty ? (
            <div className="relative overflow-hidden px-5 pt-16 pb-6">
              <div aria-hidden="true" className="grille-soft absolute inset-0" />
              <div className="relative flex max-w-prose flex-col gap-2">
                <h2 className="text-3xl leading-tight font-bold">{t("message.empty.title")}</h2>
                <p className="text-text-muted">{t("message.empty.body")}</p>
              </div>
            </div>
          ) : null}
          <div ref={rowsRef}>
            {rows.map((row) => (
              <div key={row.key} data-key={row.key}>
                {row.kind === "date" ? (
                  <div
                    className="meta mt-4 mb-1 flex items-center gap-3 px-5 text-text-muted"
                    role="separator"
                  >
                    <span aria-hidden="true" className="h-px w-8 bg-accent" />
                    {row.label}
                    <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  </div>
                ) : row.kind === "unread" ? (
                  <div
                    className="meta my-1 flex items-center gap-3 px-5 font-medium text-danger-text"
                    role="separator"
                  >
                    <span aria-hidden="true" className="h-px flex-1 bg-danger" />
                    {t("message.new")}
                  </div>
                ) : row.kind === "message" ? (
                  <MessageItem
                    message={row.message}
                    grouped={row.grouped}
                    highlight={highlight === row.message.id}
                    selfId={selfId}
                    perms={perms}
                    onReply={onReply}
                    onJump={onJump}
                  />
                ) : (
                  <PendingItem p={row.pending} selfName={selfName} selfAvatar={selfAvatar} />
                )}
              </div>
            ))}
          </div>
          {win.hasNewer && loading ? (
            <div className="p-2 text-center text-sm text-text-muted" role="status">
              {t("app.loading")}
            </div>
          ) : null}
        </div>
      </div>
      {!atBottom || win.hasNewer ? (
        <Button
          onClick={() => {
            pinned.current = true;
            wantLatest.current = true;
            setAtBottom(true);
            if (win.hasNewer) void jumpToLatest(channelId);
            else settle();
          }}
          className="absolute end-5 bottom-3 shadow-lg"
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
