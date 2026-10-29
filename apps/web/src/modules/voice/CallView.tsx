// SPDX-License-Identifier: AGPL-3.0-or-later
import { Eye, Phone } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import type { VoiceParticipant } from "@tincan/shared";
import { useT } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { memberName, useCanIn, useCommunity } from "../../core/state/community.js";
import { dismissWatchNotice, joinVoice } from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import { streamKey } from "../../core/voice/video.js";
import { Button } from "../../ui/Button.js";
import { toastError } from "../../ui/toast.js";
import { ControlBar } from "./ControlBar.js";
import { StreamView } from "./StreamView.js";
import { PersonTile, ScreenTile, TileGrid } from "./Tiles.js";

const NONE: never[] = [];

type Tile = { kind: "person" | "screen"; p: VoiceParticipant; key: string };

/**
 * Tiles in presence order, each person followed by their screen share. Watched screens move to the front, so the order
 * changes only when someone starts or stops a stream, never when someone speaks (W-12).
 */
export function orderTiles(
  people: readonly VoiceParticipant[],
  watching: Record<string, true>,
  selfSharing: boolean,
  self: string,
): Tile[] {
  const tiles: Tile[] = [];
  for (const p of people) {
    tiles.push({ kind: "person", p, key: `${p.userId}:person` });
    if (p.sources.includes("screen_share") || (p.userId === self && selfSharing)) {
      tiles.push({ kind: "screen", p, key: streamKey(p.userId, "screen") });
    }
  }
  const front = tiles.filter((x) => x.kind === "screen" && watching[x.key]);
  return [...front, ...tiles.filter((x) => !front.includes(x))];
}

/** The call: tiles with cameras, screen shares, stream view and controls (W-10 to W-12). */
export function CallView() {
  const t = useT();
  const { channelId = "" } = useParams();
  const channel = useCommunity((s) => s.channels.find((c) => c.id === channelId));
  const ready = useCommunity((s) => s.ready);
  const people = useVoice((s) => s.presence[channelId]) ?? NONE;
  const inThis = useVoice((s) => s.channelId === channelId && s.status !== "idle" && s.status !== "failed");
  const connecting = useVoice((s) => s.status === "connecting" && s.channelId === channelId);
  const watching = useVoice((s) => s.watching);
  const screenOn = useVoice((s) => s.screenOn);
  const self = useSession((s) => s.user?.id ?? "");
  const canConnect = useCanIn(channelId, "CONNECT");
  const noticeFor = useVoice((s) => s.watchNotice);
  const noticeName = useCommunity((s) => (noticeFor ? memberName(s.members[noticeFor], noticeFor) : ""));
  const [layout, setLayout] = useState<"focus" | "grid">("focus");
  const [focus, setFocus] = useState<string | null>(null);

  // Streams that are watched and still live (a share that ended drops out of presence).
  const live = Object.keys(watching).filter((k) => {
    const [userId, source] = [k.slice(0, k.lastIndexOf(":")), k.slice(k.lastIndexOf(":") + 1)];
    const p = people.find((x) => x.userId === userId);
    return p?.sources.includes(source === "screen" ? "screen_share" : "camera") === true;
  });
  const screens = live.filter((k) => k.endsWith(":screen"));
  // Watching a second stream switches to the grid (W-11).
  useEffect(() => {
    if (screens.length > 1) setLayout("grid");
  }, [screens.length]);
  const focused = focus && screens.includes(focus) ? focus : (screens.at(-1) ?? null);

  if (ready && (!channel || channel.type !== "voice")) return <Navigate to="/" replace />;
  if (!channel) return null;

  const open = (key: string) => {
    setFocus(key);
    setLayout("focus");
  };
  const tiles = orderTiles(people, watching, screenOn, self);
  const strip = layout === "focus" && focused ? tiles.filter((x) => x.key !== focused) : tiles;
  const grid = (
    <TileGrid
      label={t("video.tiles")}
      className={
        layout === "focus" && focused
          ? "grid-flow-col auto-cols-[14rem] overflow-x-auto"
          : "grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]"
      }
    >
      {strip.map((x, i) =>
        x.kind === "person" ? (
          <PersonTile key={x.key} p={x.p} channelId={channelId} index={i} />
        ) : (
          <ScreenTile key={x.key} p={x.p} channelId={channelId} index={i} onOpen={open} />
        ),
      )}
    </TileGrid>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border ps-4 pe-16">
        <h1 className="m-0 min-w-0 flex-1 truncate text-lg font-semibold">
          <bdi>{t("voice.call.title", { name: channel.name, count: people.length })}</bdi>
        </h1>
        {screens.length > 0 ? (
          <div role="group" aria-label={t("video.layout")} className="flex gap-1 text-sm">
            {(["focus", "grid"] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={layout === l}
                className="rounded-md px-2 py-1 hover:bg-bg-hover aria-pressed:bg-bg-hover aria-pressed:font-semibold"
                onClick={() => setLayout(l)}
              >
                {t(l === "focus" ? "video.layout.focus" : "video.layout.grid")}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {noticeFor ? (
        <div
          role="status"
          className="flex items-center gap-3 border-b border-border bg-bg-sidebar px-4 py-2 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Escape") void dismissWatchNotice();
          }}
        >
          <Eye aria-hidden="true" size={16} />
          <span className="flex-1">{t("video.watchNotice", { name: noticeName })}</span>
          <Button variant="ghost" onClick={() => void dismissWatchNotice()}>
            {t("video.gotIt")}
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {people.length === 0 ? <p className="text-text-muted">{t("voice.call.empty")}</p> : null}
        {layout === "focus" && focused ? <StreamView streamKey={focused} /> : null}
        {grid}
      </div>
      {inThis ? (
        <ControlBar />
      ) : (
        <div className="flex justify-center border-t border-border p-4">
          <Button
            disabled={!canConnect || connecting}
            onClick={() => void joinVoice(channelId).catch(toastError)}
          >
            <Phone aria-hidden="true" size={16} />
            {t("voice.call.join")}
          </Button>
        </div>
      )}
    </div>
  );
}
