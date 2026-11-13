// SPDX-License-Identifier: AGPL-3.0-or-later
import { has, newId, type Message, type NotificationLevel, type PushPayload } from "@tincan/shared";
import type { Db } from "@tincan/db";
import type { Logger } from "../../framework/types.js";
import type { AccountsApi } from "../accounts/api.js";
import type { ChannelsApi } from "../channels/api.js";
import type { RolesApi } from "../roles/api.js";
import type { TextChatApi } from "../text-chat/api.js";
import type { PushTables } from "./schema.js";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Sends one encrypted push. Throws an error with a numeric `statusCode` when the push service refuses. */
export interface PushSender {
  send(
    target: PushTarget,
    payload: string,
    opts: { ttlSecs: number; urgency: "normal" | "high"; topic: string },
  ): Promise<void>;
}

export interface PushDeps {
  db: Db<PushTables>;
  sender: PushSender;
  accounts: AccountsApi;
  roles: RolesApi;
  channels: ChannelsApi;
  text: TextChatApi;
  isOnline: (userId: string) => boolean;
  contentMode: "full" | "generic";
  maxPerUser: number;
  log: Logger;
  now?: () => number;
}

/** Stale chat pushes are worse than none: a message the user can read in the app is not worth a late buzz. */
const TTL_SECS = 60 * 60;
const MAX_FAILS = 5;
const CONCURRENCY = 8;
const BODY_MAX = 140;

/** Same rules as the web client's `levelFor` (12 §5.4): a muted channel announces mentions only. */
export function levelFor(
  settings: Record<string, unknown>,
  channelId: string,
  now: number,
): NotificationLevel {
  const fallback = (settings["notifications.default"] as NotificationLevel | undefined) ?? "all";
  const pref = settings[`notifications.channel.${channelId}`] as
    { level?: NotificationLevel; mutedUntil?: number | null } | undefined;
  if (pref?.mutedUntil && pref.mutedUntil > now) return "mentions";
  return pref?.level ?? fallback;
}

function plain(content: string): string {
  return content.replace(/<@&?[0-9A-Z]{26}>/g, "@…").replace(/<#[0-9A-Z]{26}>/g, "#…");
}

export class PushService {
  readonly #d: PushDeps;
  readonly #now: () => number;

  constructor(deps: PushDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  async subscribe(userId: string, sessionId: string, sub: PushTarget): Promise<void> {
    const { db } = this.#d;
    const now = this.#now();
    await db.transaction(async (tx) => {
      // The same browser endpoint moves to whoever subscribed last (shared computer, account switch).
      await tx.query.deleteFrom("push_subscription").where("endpoint", "=", sub.endpoint).execute();
      await tx.query
        .insertInto("push_subscription")
        .values({
          id: newId(now),
          user_id: userId,
          session_id: sessionId,
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          created_at: now,
          last_ok_at: null,
          fail_count: 0,
        })
        .execute();
      const rows = await tx.query
        .selectFrom("push_subscription")
        .select("id")
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .execute();
      const extra = rows.slice(this.#d.maxPerUser).map((r) => r.id);
      if (extra.length > 0) await tx.query.deleteFrom("push_subscription").where("id", "in", extra).execute();
    });
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.#d.db.query
      .deleteFrom("push_subscription")
      .where("user_id", "=", userId)
      .where("endpoint", "=", endpoint)
      .execute();
  }

  async removeForSession(sessionId: string): Promise<void> {
    await this.#d.db.query.deleteFrom("push_subscription").where("session_id", "=", sessionId).execute();
  }

  async removeForUser(userId: string): Promise<void> {
    await this.#d.db.query.deleteFrom("push_subscription").where("user_id", "=", userId).execute();
  }

  async count(userId: string): Promise<number> {
    const rows = await this.#d.db.query
      .selectFrom("push_subscription")
      .select("id")
      .where("user_id", "=", userId)
      .execute();
    return rows.length;
  }

  /** Pushes a new message to everyone who should hear about it and has no open app (a live socket shows it in the page). */
  async notifyMessage(e: { messageId: string; channelId: string; authorId: string }): Promise<void> {
    const subs = await this.#d.db.query.selectFrom("push_subscription").selectAll().execute();
    const candidates = [...new Set(subs.map((s) => s.user_id))].filter(
      (u) => u !== e.authorId && !this.#d.isOnline(u),
    );
    if (candidates.length === 0) return;
    const [message] = await this.#d.text.getMessages([e.messageId]);
    const channel = await this.#d.channels.get(e.channelId);
    if (!message || !channel || channel.archivedAt !== null) return;
    const settings = await this.#d.accounts.settingsOf(candidates);
    const now = this.#now();
    const jobs: { sub: (typeof subs)[number]; payload: string; urgent: boolean }[] = [];
    for (const userId of candidates) {
      if (!has(await this.#d.roles.permissionsIn(userId, e.channelId), "VIEW_CHANNEL")) continue;
      const level = levelFor(settings.get(userId) ?? {}, e.channelId, now);
      if (level === "none") continue;
      const mentioned = this.#mentions(message, userId, await this.#d.roles.roleIdsOf(userId));
      if (level === "mentions" && !mentioned) continue;
      const payload = JSON.stringify(this.#payload(message, channel.name));
      for (const sub of subs) if (sub.user_id === userId) jobs.push({ sub, payload, urgent: mentioned });
    }
    for (let i = 0; i < jobs.length; i += CONCURRENCY)
      await Promise.all(
        jobs.slice(i, i + CONCURRENCY).map((j) => this.#deliver(j.sub, j.payload, j.urgent, e.channelId)),
      );
  }

  /** A nudge is a deliberate ping: while the target has no live socket it goes out as a push. */
  async notifyNudge(e: { senderId: string; senderName: string; targetId: string }): Promise<void> {
    if (this.#d.isOnline(e.targetId)) return;
    const subs = await this.#d.db.query
      .selectFrom("push_subscription")
      .selectAll()
      .where("user_id", "=", e.targetId)
      .execute();
    if (subs.length === 0) return;
    const generic = this.#d.contentMode === "generic";
    const payload = JSON.stringify({
      tag: "nudge",
      title: generic ? "Someone nudged you" : `${e.senderName} nudged you`,
      body: "",
    } satisfies PushPayload);
    for (const sub of subs) await this.#deliver(sub, payload, true, "nudge");
  }

  #mentions(m: Message, userId: string, roleIds: readonly string[]): boolean {
    return (
      m.mentions.everyone ||
      m.mentions.users.includes(userId) ||
      m.mentions.roles.some((r) => roleIds.includes(r))
    );
  }

  #payload(m: Message, channelName: string): PushPayload {
    const generic = this.#d.contentMode === "generic";
    const author = m.author?.displayName ?? "Someone";
    return {
      channelId: m.channelId,
      messageId: m.id,
      title: generic ? `New message in #${channelName}` : `${author} in #${channelName}`,
      body: generic ? "" : plain(m.content).slice(0, BODY_MAX) || "Sent a file",
    };
  }

  async #deliver(
    sub: PushTables["push_subscription"],
    payload: string,
    urgent: boolean,
    topic: string,
  ): Promise<void> {
    const { db, sender, log } = this.#d;
    try {
      await sender.send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
        ttlSecs: TTL_SECS,
        urgency: urgent ? "high" : "normal",
        topic,
      });
      await db.query
        .updateTable("push_subscription")
        .set({ last_ok_at: this.#now(), fail_count: 0 })
        .where("id", "=", sub.id)
        .execute();
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410: the browser dropped the subscription. 401/403: the key changed. Neither will ever work again.
      if (status === 404 || status === 410 || status === 401 || status === 403) {
        await db.query.deleteFrom("push_subscription").where("id", "=", sub.id).execute();
        return;
      }
      log.warn({ status, userId: sub.user_id }, "push delivery failed");
      if (sub.fail_count + 1 >= MAX_FAILS)
        await db.query.deleteFrom("push_subscription").where("id", "=", sub.id).execute();
      else
        await db.query
          .updateTable("push_subscription")
          .set({ fail_count: sub.fail_count + 1 })
          .where("id", "=", sub.id)
          .execute();
    }
  }
}
