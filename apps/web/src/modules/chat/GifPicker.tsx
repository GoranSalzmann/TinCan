// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { GifItem, GifProvider } from "@tincan/shared";
import { api, gifMediaUrl } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";

const RECENT_KEY = "tincan.gifs.recent";
const RECENT_MAX = 24;

/** What localStorage remembers of a pick; the URLs are rebuilt so they always point at this server. */
interface RecentGif {
  provider: GifProvider;
  id: string;
  title: string;
  width: number;
  height: number;
}

function loadRecent(): RecentGif[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is RecentGif =>
        typeof x === "object" && x !== null && "provider" in x && "id" in x && "title" in x,
    );
  } catch {
    return [];
  }
}

function remember(item: GifItem): void {
  try {
    const cur = loadRecent().filter((x) => !(x.provider === item.provider && x.id === item.id));
    cur.unshift({
      provider: item.provider,
      id: item.id,
      title: item.title,
      width: item.width,
      height: item.height,
    });
    localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, RECENT_MAX)));
  } catch {
    // Private windows may refuse storage; "recently used" is a convenience only.
  }
}

const asItem = (r: RecentGif): GifItem => ({
  ...r,
  previewUrl: gifMediaUrl(r.provider, r.id, "preview"),
  mediaUrl: gifMediaUrl(r.provider, r.id, "full"),
});

const providerName = (t: (k: MessageKey) => string, p: GifProvider): string =>
  p === "tenor" ? t("gifs.provider.tenor") : t("gifs.provider.giphy");

/** The composer GIF picker: search/trending grid whose images all come from this server (17 §10). */
export function GifPicker({
  providers,
  onPick,
  onClose,
}: {
  providers: GifProvider[];
  onPick: (item: GifItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [provider, setProvider] = useState<GifProvider>(providers[0] ?? "tenor");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [recent, setRecent] = useState<RecentGif[]>(loadRecent);
  const [items, setItems] = useState<GifItem[]>([]);
  const [next, setNext] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const name = providerName(t, provider);

  // Close on Escape and on clicks outside the panel (the toggle button opts out via data-gif-toggle).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (panel.current && !panel.current.contains(target) && !target.closest("[data-gif-toggle]")) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const fetchPage = useCallback(
    async (pos: string) => {
      setLoading(true);
      setError(false);
      try {
        const page = debounced
          ? await api.searchGifs(provider, debounced, pos || undefined)
          : await api.trendingGifs(provider, pos || undefined);
        setItems((cur) => (pos ? [...cur, ...page.items] : page.items));
        setNext(page.next);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [provider, debounced],
  );

  useEffect(() => {
    setItems([]);
    setNext("");
    void fetchPage("");
  }, [fetchPage]);

  const pick = (item: GifItem) => {
    remember(item);
    setRecent(loadRecent());
    onPick(item);
  };

  const grid = (list: GifItem[]) => (
    <div className="grid grid-cols-2 gap-1">
      {list.map((item) => (
        <button
          key={`${item.provider}-${item.id}`}
          type="button"
          aria-label={item.title}
          onClick={() => pick(item)}
          className="overflow-hidden rounded-md bg-bg-input hover:outline-2 hover:outline-accent"
        >
          <img
            src={item.previewUrl}
            alt=""
            width={item.width}
            height={item.height}
            loading="lazy"
            style={{ aspectRatio: `${item.width} / ${item.height}` }}
            className="h-full w-full object-cover"
          />
        </button>
      ))}
    </div>
  );

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={t("gifs.title")}
      className="elev-2 absolute bottom-full end-0 mb-1 z-10 flex h-96 w-[26rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border bg-bg-sidebar"
    >
      <div className="flex items-center gap-1 p-2">
        {providers.length > 1 ? (
          <div className="flex gap-1" role="tablist" aria-label={t("gifs.title")}>
            {providers.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={p === provider}
                onClick={() => setProvider(p)}
                className={`rounded-md px-2 py-1 text-xs font-semibold ${p === provider ? "bg-bg-selected" : "hover:bg-bg-hover"}`}
              >
                {providerName(t, p)}
              </button>
            ))}
          </div>
        ) : null}
        <input
          autoFocus
          type="search"
          value={query}
          placeholder={t("gifs.search", { provider: name })}
          aria-label={t("gifs.search", { provider: name })}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border-control bg-bg-input px-2 py-1 text-sm outline-none"
        />
        <button
          type="button"
          aria-label={t("gifs.close")}
          onClick={onClose}
          className="rounded-md p-1 hover:bg-bg-hover"
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 pt-0">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-text-muted">
            {t("gifs.error")}
            <button
              type="button"
              onClick={() => void fetchPage("")}
              className="rounded-md bg-bg-selected px-3 py-1 text-xs font-semibold"
            >
              {t("gifs.retry")}
            </button>
          </div>
        ) : (
          <>
            {debounced === "" && recent.length > 0 ? (
              <>
                <div className="pb-1 pt-2 text-xs font-semibold text-text-muted">{t("gifs.recent")}</div>
                {grid(recent.map(asItem))}
                <div className="pb-1 pt-2 text-xs font-semibold text-text-muted">{t("gifs.trending")}</div>
              </>
            ) : null}
            {items.length > 0 ? (
              grid(items)
            ) : !loading ? (
              <div className="flex h-full items-center justify-center text-sm text-text-muted">
                {t("gifs.empty")}
              </div>
            ) : null}
            {next ? (
              <button
                type="button"
                disabled={loading}
                onClick={() => void fetchPage(next)}
                className="mt-1 w-full rounded-md bg-bg-selected py-1 text-xs font-semibold disabled:opacity-60"
              >
                {t("gifs.more")}
              </button>
            ) : null}
          </>
        )}
      </div>
      <div className="border-t border-border px-2 py-1 text-end text-xs text-text-muted">
        {t("gifs.poweredBy", { provider: name })}
      </div>
    </div>
  );
}
