// SPDX-License-Identifier: AGPL-3.0-or-later
import { Headphones, MicOff } from "lucide-react";
import type { VoiceParticipant } from "@tincan/shared";
import { useT } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import { useVoice } from "../../core/voice/store.js";
import { Avatar } from "../../ui/Avatar.js";

/**
 * Speaking is shown by a ring (shape) and by the label for assistive technology, never by colour alone
 * (style guide §4). Tiles do not reorder when someone speaks (design W-10).
 */
function useParticipantView(p: VoiceParticipant) {
  const t = useT();
  const member = useCommunity((s) => s.members[p.userId]);
  const self = useSession((s) => s.user?.id);
  const speaking = useVoice((s) => s.speaking[p.userId] === true);
  const quality = useVoice((s) => s.quality[p.userId]);
  const mine = p.userId === self;
  // Our own mute/deafen is known locally and immediately; others' come from the server.
  const localMuted = useVoice((s) => s.muted);
  const localDeaf = useVoice((s) => s.deafened);
  const name = memberName(member, p.userId);
  return {
    t,
    name,
    avatarKey: member?.avatarKey,
    speaking,
    quality,
    mine,
    muted: mine ? localMuted : p.muted,
    deafened: mine ? localDeaf : p.deafened,
    label: mine ? t("voice.you", { name }) : name,
  };
}

/** One row under a voice channel in the sidebar (W-02). */
export function ParticipantRow({ p }: { p: VoiceParticipant }) {
  const v = useParticipantView(p);
  return (
    <li
      className="flex min-h-7 items-center gap-2 ps-8 pe-2 text-sm text-text-muted"
      aria-label={v.speaking ? v.t("voice.speaking", { name: v.name }) : undefined}
    >
      <span className={`rounded-full ${v.speaking ? "ring-2 ring-success" : ""}`}>
        <Avatar name={v.name} avatarKey={v.avatarKey} size={20} />
      </span>
      <bdi className="min-w-0 flex-1 truncate">{v.label}</bdi>
      {v.deafened ? (
        <Headphones aria-label={v.t("voice.deafened")} size={14} className="shrink-0" />
      ) : v.muted ? (
        <MicOff aria-label={v.t("voice.muted")} size={14} className="shrink-0" />
      ) : null}
    </li>
  );
}

/** A tile in the call view (W-10). */
export function ParticipantTile({
  p,
  onVolume,
}: {
  p: VoiceParticipant;
  onVolume?: (volume: number) => void;
}) {
  const v = useParticipantView(p);
  return (
    <li
      className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 bg-bg-sidebar p-6 ${v.speaking ? "border-success" : "border-transparent"}`}
      aria-label={v.speaking ? v.t("voice.speaking", { name: v.name }) : v.label}
    >
      <Avatar name={v.name} avatarKey={v.avatarKey} size={72} />
      <div className="flex items-center gap-2">
        <bdi className="max-w-48 truncate font-medium">{v.label}</bdi>
        {v.deafened ? (
          <Headphones aria-label={v.t("voice.deafened")} size={16} />
        ) : v.muted ? (
          <MicOff aria-label={v.t("voice.muted")} size={16} />
        ) : null}
      </div>
      {v.quality === "poor" || v.quality === "lost" ? (
        <span className="text-xs text-warning-text">
          {v.t(v.quality === "lost" ? "voice.quality.lost" : "voice.quality.poor")}
        </span>
      ) : null}
      {onVolume && !v.mine ? (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          defaultValue={1}
          aria-label={v.t("voice.volume", { name: v.name })}
          onChange={(e) => onVolume(Number(e.target.value))}
          className="w-32"
        />
      ) : null}
    </li>
  );
}
