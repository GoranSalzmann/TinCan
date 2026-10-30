// SPDX-License-Identifier: AGPL-3.0-or-later
import { Lock, LockOpen } from "lucide-react";
import type { Channel } from "@tincan/shared";
import { useT } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { useVoice } from "../../core/voice/store.js";

/** Whether calls in a channel are encrypted, from its own setting and the server default (10 §5). */
export function useChannelEncrypted(channel: Pick<Channel, "settings">): boolean {
  const serverDefault = useSession((s) => {
    const v = s.capabilities?.features.voice;
    return typeof v === "object" && v !== null && (v as { e2ee?: boolean }).e2ee === true;
  });
  const mode = channel.settings.e2ee ?? "inherit";
  return mode === "required" || (mode === "inherit" && serverDefault);
}

const tip = "voice.e2ee.tooltip" as const;

/** The lock on a voice channel in the sidebar. Says what is protected and what is not (10 §2): never "verified". */
export function ChannelLock({ channel }: { channel: Pick<Channel, "settings"> }) {
  const t = useT();
  const on = useChannelEncrypted(channel);
  if (!on) return null;
  return (
    <span title={t(tip)} className="shrink-0 text-text-muted">
      <Lock aria-label={t("voice.e2ee.on")} size={13} />
    </span>
  );
}

/** The indicator in the call header and the dock: follows what this client really negotiated, not the setting. */
export function CallLock() {
  const t = useT();
  const state = useVoice((s) => s.e2ee);
  if (state === "off") return null;
  const Icon = state === "resyncing" ? LockOpen : Lock;
  return (
    <span role="status" title={t(tip)} className="flex shrink-0 items-center gap-1 text-sm text-text-muted">
      <Icon aria-hidden="true" size={14} />
      {state === "resyncing" ? t("voice.e2ee.resyncing") : t("voice.e2ee.on")}
    </span>
  );
}
