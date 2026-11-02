// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useState } from "react";
import { Play, X } from "lucide-react";
import { extractPreviewUrls, type LinkPreview } from "@tincan/shared";
import { api, linkPreviewImageUrl } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { toastError } from "../../ui/toast.js";

/** Previews already asked for, so a message scrolled out and back does not ask again. Keyed by id and text. */
const asked = new Map<string, Promise<LinkPreview[]>>();

function ask(messageId: string, key: string): Promise<LinkPreview[]> {
  let p = asked.get(key);
  if (!p) {
    p = api
      .linkPreviews(messageId)
      .then((r) => r.previews)
      .catch(() => []);
    asked.set(key, p);
    if (asked.size > 500) asked.delete(asked.keys().next().value!);
  }
  return p;
}

/** True when the owner has turned previews on (the server publishes it in its capabilities). */
export function useLinkPreviewsEnabled(): boolean {
  return useSession((s) => {
    const f = s.capabilities?.features["link-previews"];
    return typeof f === "object" && f !== null && (f as { enabled?: unknown }).enabled === true;
  });
}

/**
 * Cards for the links in a message (23 §8). The server reads the pages; the card shows plain text and an image
 * served by this server. Nothing is requested for a message without links or while previews are off.
 */
export function LinkPreviews({
  messageId,
  content,
  editedAt,
  canRemove,
}: {
  messageId: string;
  content: string;
  editedAt: string | null;
  canRemove: boolean;
}) {
  const enabled = useLinkPreviewsEnabled();
  const hasLinks = useMemo(() => extractPreviewUrls(content).length > 0, [content]);
  const [previews, setPreviews] = useState<LinkPreview[]>([]);
  const key = `${messageId}:${editedAt ?? ""}`;
  useEffect(() => {
    if (!enabled || !hasLinks) {
      setPreviews([]);
      return;
    }
    let live = true;
    void ask(messageId, key).then((p) => live && setPreviews(p));
    return () => {
      live = false;
    };
  }, [enabled, hasLinks, messageId, key]);
  if (previews.length === 0) return null;
  const remove = () => {
    void api
      .removeLinkPreviews(messageId)
      .then(() => {
        asked.set(key, Promise.resolve([]));
        setPreviews([]);
      })
      .catch(toastError);
  };
  return (
    <div className="flex flex-col">
      {previews.map((p, i) => (
        <PreviewCard key={p.url} preview={p} onRemove={canRemove && i === 0 ? remove : null} />
      ))}
    </div>
  );
}

export function PreviewCard({
  preview: p,
  onRemove,
}: {
  preview: LinkPreview;
  onRemove: (() => void) | null;
}) {
  const t = useT();
  const host = useMemo(() => {
    try {
      return new URL(p.url).hostname.replace(/^www\./, "");
    } catch {
      return p.url;
    }
  }, [p.url]);
  const title = p.title ?? host;
  const w = p.imageWidth ? Math.min(p.imageWidth, 360) : null;
  const h = p.imageWidth && p.imageHeight && w ? Math.round((p.imageHeight * w) / p.imageWidth) : null;
  return (
    <article
      aria-label={t("link.preview.label", { title })}
      className="relative my-1 flex max-w-md flex-col gap-1 rounded-md border border-border border-s-4 border-s-accent bg-bg-sidebar p-3"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-text-muted">
            {p.siteName ?? host}
            {p.video ? ` · ${t("link.preview.video")}` : ""}
          </div>
          {/* Text from another site: always a text node, never markup. */}
          <a
            href={p.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="block break-words text-sm font-semibold text-text-link"
          >
            {title}
          </a>
        </div>
        {onRemove ? (
          <button
            type="button"
            aria-label={t("link.preview.remove")}
            title={t("link.preview.remove")}
            onClick={onRemove}
            className="shrink-0 rounded-md p-1 text-text-muted hover:bg-bg-hover"
          >
            <X aria-hidden="true" size={14} />
          </button>
        ) : null}
      </div>
      {p.description ? <p className="m-0 line-clamp-3 text-sm break-words">{p.description}</p> : null}
      {p.image ? (
        <a
          href={p.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          tabIndex={-1}
          className="relative mt-1 block"
        >
          <img
            src={linkPreviewImageUrl(p.image)}
            alt=""
            loading="lazy"
            {...(w && h ? { width: w, height: h } : {})}
            className="max-h-60 max-w-full rounded-md bg-bg-input object-cover"
          />
          {p.video ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 m-auto flex size-10 items-center justify-center rounded-full bg-black/60 text-white"
            >
              <Play size={20} />
            </span>
          ) : null}
        </a>
      ) : null}
    </article>
  );
}
