// SPDX-License-Identifier: AGPL-3.0-or-later
import { Phone } from "lucide-react";
import { Navigate, useParams } from "react-router-dom";
import { useT } from "../../core/i18n/index.js";
import { useCanIn, useCommunity } from "../../core/state/community.js";
import { joinVoice, setPlaybackVolume } from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import { Button } from "../../ui/Button.js";
import { toastError } from "../../ui/toast.js";
import { ParticipantTile } from "./Participants.js";

const NONE: never[] = [];

/** The call: who is here, with a place to join (W-10, without video and screen share until M4). */
export function CallView() {
  const t = useT();
  const { channelId = "" } = useParams();
  const channel = useCommunity((s) => s.channels.find((c) => c.id === channelId));
  const ready = useCommunity((s) => s.ready);
  const people = useVoice((s) => s.presence[channelId]) ?? NONE;
  const inThis = useVoice((s) => s.channelId === channelId && s.status !== "idle" && s.status !== "failed");
  const connecting = useVoice((s) => s.status === "connecting" && s.channelId === channelId);
  const canConnect = useCanIn(channelId, "CONNECT");

  if (ready && (!channel || channel.type !== "voice")) return <Navigate to="/" replace />;
  if (!channel) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border ps-4 pe-16">
        <h1 className="m-0 min-w-0 flex-1 truncate text-lg font-semibold">
          <bdi>{t("voice.call.title", { name: channel.name, count: people.length })}</bdi>
        </h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {people.length === 0 ? <p className="text-text-muted">{t("voice.call.empty")}</p> : null}
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 p-0">
          {people.map((p) => (
            <ParticipantTile key={p.userId} p={p} onVolume={(v) => void setPlaybackVolume(p.userId, v)} />
          ))}
        </ul>
      </div>
      {!inThis ? (
        <div className="flex justify-center border-t border-border p-4">
          <Button
            disabled={!canConnect || connecting}
            onClick={() => void joinVoice(channelId).catch(toastError)}
          >
            <Phone aria-hidden="true" size={16} />
            {t("voice.call.join")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
