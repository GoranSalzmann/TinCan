// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { Pause, Play } from "lucide-react";
import type { MessageGif } from "@tincan/shared";
import { gifMediaUrl } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { usePrefersReducedMotion } from "./media.js";

// Renders a message GIF: autoplays the full animation unless prefers-reduced-motion,
// then shows the still with a play/pause overlay button (mirrors AnimatedImage in AttachmentView.tsx).
export function GifAttachment({ gif }: { gif: MessageGif }) {
  const t = useT();
  const reduced = usePrefersReducedMotion();
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const playing = !failed && (chosen ?? !reduced);
  const w = Math.min(gif.width, 360);
  const h = Math.round((gif.height * w) / gif.width);
  const Icon = playing ? Pause : Play;
  return (
    <div className="my-1 inline-block max-w-full">
      <div className="relative inline-block max-w-full">
        <img
          src={gifMediaUrl(gif.provider, gif.id, playing ? "full" : "still")}
          alt={gif.title}
          width={w}
          height={h}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
          className="max-h-80 max-w-full rounded-md bg-bg-input object-contain"
        />
        <button
          type="button"
          aria-pressed={playing}
          aria-label={playing ? t("gifs.pause", { name: gif.title }) : t("gifs.play", { name: gif.title })}
          onClick={() => setChosen(!playing)}
          className="elev-2 absolute start-2 bottom-2 flex min-h-8 items-center gap-1 rounded-md bg-bg-sidebar px-2 text-xs font-semibold text-text"
        >
          <Icon aria-hidden="true" size={14} />
          GIF
        </button>
      </div>
      <span className="block text-xs text-text-muted">
        {gif.title} · {gif.width} × {gif.height}
      </span>
    </div>
  );
}
