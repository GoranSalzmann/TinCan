// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { avatarUrl } from "../core/api/client.js";
import type { PresenceStatus } from "../core/state/community.js";

/** Presence is shown by shape as well as colour (style guide §4): filled, hollow, bar-through, empty. */
export function PresenceDot({ status, className = "" }: { status: PresenceStatus; className?: string }) {
  const base = "inline-block size-2.5 shrink-0 rounded-full border-2";
  const look =
    status === "online"
      ? "border-presence-online bg-presence-online"
      : status === "idle"
        ? "border-presence-idle bg-transparent"
        : status === "dnd"
          ? "border-presence-dnd bg-presence-dnd"
          : "border-presence-offline bg-transparent";
  return <span aria-hidden="true" className={`${base} ${look} ${className}`} />;
}

export function Avatar({
  name,
  avatarKey,
  size = 32,
  className = "",
}: {
  name: string;
  avatarKey?: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.44)) };
  if (avatarKey && !failed) {
    return (
      <img
        src={avatarUrl(avatarKey)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        style={style}
        className={`shrink-0 rounded-full bg-bg-input object-cover ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={style}
      className={`flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-text-on-accent ${className}`}
    >
      <bdi>{[...name][0]?.toUpperCase() ?? "?"}</bdi>
    </span>
  );
}
