// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Message } from "@tincan/shared";
import { api, ApiError } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { useChat } from "../../core/state/chat.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import { Modal } from "../../ui/Dialog.js";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Search across the channels you can read (Q4, 06 §3.9). Results jump to the message with `around`. */
export function SearchDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const channels = useCommunity((s) => s.channels);
  const members = useCommunity((s) => s.members);
  const [q, setQ] = useState("");
  const [here, setHere] = useState(false);
  const [sort, setSort] = useState<"newest" | "relevance">("newest");
  const [results, setResults] = useState<Message[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const run = async (more: boolean) => {
    const my = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const page = await api.search({
        q,
        sort,
        ...(here ? { channelId } : {}),
        ...(more && cursor ? { cursor } : {}),
      });
      if (my !== seq.current) return;
      setResults((cur) => (more && cur ? [...cur, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      if (my !== seq.current) return;
      setError(
        e instanceof ApiError && e.code === "RATE_LIMITED" ? t("search.slowDown") : t("search.failed"),
      );
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  // Search as you type, after a short pause.
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    const id = setTimeout(() => void run(false), 300);
    return () => clearTimeout(id);
  }, [q, here, sort]);

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("search.title")} wide>
      <div className="flex flex-col gap-3">
        <input
          autoFocus
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t("search.label")}
          placeholder={t("search.placeholder")}
          className="min-h-9 rounded-md border border-border-control bg-bg-input px-3"
        />
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={here} onChange={(e) => setHere(e.target.checked)} />
            {t("search.thisChannel")}
          </label>
          <label className="flex items-center gap-2">
            {t("search.sort")}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as "newest" | "relevance")}
              className="rounded-md border border-border-control bg-bg-input px-2 py-1"
            >
              <option value="newest">{t("search.sort.newest")}</option>
              <option value="relevance">{t("search.sort.relevance")}</option>
            </select>
          </label>
        </div>
        <div aria-live="polite" role="status" className="min-h-5 text-sm text-text-muted">
          {error ?? (busy ? t("check.running") : results && results.length === 0 ? t("search.none") : "")}
        </div>
        <ul className="m-0 flex max-h-96 list-none flex-col gap-1 overflow-y-auto p-0">
          {(results ?? []).map((m) => {
            const channel = channels.find((c) => c.id === m.channelId);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    void navigate(`/channels/${m.channelId}`);
                    void useChat.getState().jumpTo(m.channelId, m.id);
                    onClose();
                  }}
                  className="w-full rounded-md border border-border p-2 text-start hover:bg-bg-hover"
                >
                  <span className="flex items-baseline gap-2 text-sm">
                    <span className="font-semibold">
                      {memberName(members[m.authorId], m.author?.displayName ?? t("message.deletedUser"))}
                    </span>
                    <span className="text-text-muted">#{channel?.name ?? "?"}</span>
                    <time dateTime={m.createdAt} className="ms-auto text-xs text-text-muted">
                      {when.format(new Date(m.createdAt))}
                    </time>
                  </span>
                  <span className="block truncate text-sm">
                    {m.content.replace(/<(@&|@|#)[0-9A-Z]{26}>/g, "…")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {cursor ? (
          <button
            type="button"
            onClick={() => void run(true)}
            className="self-center text-sm text-accent-text underline"
          >
            {t("search.more")}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
