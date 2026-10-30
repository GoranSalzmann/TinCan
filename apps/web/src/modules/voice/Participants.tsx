// SPDX-License-Identifier: AGPL-3.0-or-later
import { Headphones, MicOff } from "lucide-react";
import { useState } from "react";
import type { VoiceParticipant } from "@tincan/shared";
import { useT } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import { useVoice } from "../../core/voice/store.js";
import {
  clampVolume,
  isBoosted,
  loadVolume,
  MAX_VOLUME,
  percent,
  VOLUME_STEP,
} from "../../core/voice/volume.js";
import { Avatar } from "../../ui/Avatar.js";

/**
 * Speaking is shown by a ring (shape) and by the label for assistive technology, never by colour alone
 * (style guide §4). Tiles do not reorder when someone speaks (design W-10).
 */
export function useParticipantView(p: VoiceParticipant) {
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
    serverMuted: p.serverMuted === true,
    serverDeafened: p.serverDeafened === true,
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
      {v.serverDeafened ? (
        <Headphones
          aria-label={v.t("voice.serverDeafened")}
          size={14}
          className="shrink-0 text-danger-text"
        />
      ) : v.serverMuted ? (
        <MicOff aria-label={v.t("voice.serverMuted")} size={14} className="shrink-0 text-danger-text" />
      ) : v.deafened ? (
        <Headphones aria-label={v.t("voice.deafened")} size={14} className="shrink-0" />
      ) : v.muted ? (
        <MicOff aria-label={v.t("voice.muted")} size={14} className="shrink-0" />
      ) : null}
    </li>
  );
}

/** 0–300 %, remembered per person. Above 100 % the label turns to a warning colour and says so. */
export function VolumeSlider({
  userId,
  name,
  onVolume,
  label,
}: {
  userId: string;
  name: string;
  onVolume: (v: number) => void;
  /** Accessible name when it is not "Volume for {name}" (stream audio). */
  label?: string;
}) {
  const t = useT();
  const [value, setValue] = useState(() => loadVolume(userId));
  const boosted = isBoosted(value);
  return (
    <label className="flex flex-col items-center gap-1 text-xs">
      <input
        type="range"
        min={0}
        max={MAX_VOLUME}
        step={VOLUME_STEP}
        value={value}
        aria-label={label ?? t("voice.volume", { name })}
        aria-valuetext={`${percent(value)}%`}
        onChange={(e) => {
          const v = clampVolume(Number(e.target.value));
          setValue(v);
          onVolume(v);
        }}
        className="w-32"
      />
      <span className={boosted ? "font-semibold text-warning-text" : "text-text-muted"}>
        {boosted ? t("voice.volume.boosted", { percent: percent(value) }) : `${percent(value)}%`}
      </span>
    </label>
  );
}
