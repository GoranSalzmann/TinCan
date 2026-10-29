// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { AppError } from "@tincan/shared";
import type { GatewayRegistrar } from "../../framework/types.js";

export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

const SetArgsSchema = z.object({
  status: z.enum(["online", "idle", "dnd", "invisible"]),
});

/**
 * Presence (05 §5): online follows live sockets; the user can pick idle, do-not-disturb or invisible.
 * Held in memory, so it is rebuilt from sockets after a restart. Single node in v1 (18 T22).
 */
export class Presence {
  readonly #chosen = new Map<string, "online" | "idle" | "dnd" | "invisible">();
  readonly #gw: GatewayRegistrar;

  constructor(gw: GatewayRegistrar) {
    this.#gw = gw;
    gw.onPresenceChange((userId) => this.#announce(userId));
    gw.onCommand("presence.set", (args, ctx) => {
      const parsed = SetArgsSchema.safeParse(args);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Unknown presence status.");
      this.#chosen.set(ctx.actor.userId, parsed.data.status);
      this.#announce(ctx.actor.userId);
    });
  }

  statusOf(userId: string): PresenceStatus {
    if (!this.#gw.isOnline(userId)) return "offline";
    const chosen = this.#chosen.get(userId) ?? "online";
    return chosen === "invisible" ? "offline" : chosen;
  }

  snapshot(): Record<string, PresenceStatus> {
    const out: Record<string, PresenceStatus> = {};
    for (const id of this.#gw.onlineUserIds()) {
      const s = this.statusOf(id);
      if (s !== "offline") out[id] = s;
    }
    return out;
  }

  #announce(userId: string): void {
    this.#gw.dispatchToAll("PRESENCE_UPDATE", { userId, status: this.statusOf(userId) });
  }
}
