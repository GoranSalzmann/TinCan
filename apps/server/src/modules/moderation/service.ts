// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "@tincan/db";
import {
  AppError,
  newId,
  type AuditList,
  type Ban,
  type BanRequest,
  type TimeoutRequest,
  type VoiceModRequest,
} from "@tincan/shared";
import type { AuditInput, EventBus } from "../../framework/events.js";
import type { GatewayRegistrar, Logger } from "../../framework/types.js";
import type { AccountsApi, MemberRecord } from "../accounts/api.js";
import type { RolesApi } from "../roles/api.js";
import type { TextChatApi } from "../text-chat/api.js";
import type { VoiceApi } from "../voice/api.js";
import type { ModerationTables } from "./schema.js";

export interface ModerationDeps {
  db: Db<ModerationTables>;
  accounts: AccountsApi;
  roles: RolesApi;
  /** Absent while the module is off. */
  voice: VoiceApi | undefined;
  text: TextChatApi | undefined;
  events: EventBus;
  gateway: GatewayRegistrar;
  log: Logger;
  now?: () => number;
}

const DAY = 86_400_000;

type MemberAction = "member.kick" | "member.ban" | "member.timeout" | "member.mute" | "member.move";

/** Escapes LIKE wildcards so an action filter matches a literal prefix. */
const likePrefix = (s: string): string => s.replace(/[%_\\]/g, (c) => "\\" + c) + "%";

/**
 * Kick, ban, timeout, server mute and move, and the audit log (11 §2.4, §3). Every action checks
 * `authorizeAction` (permission and hierarchy) against the live roles, acts on live sessions and voice
 * rooms, and writes one audit row.
 */
export class ModerationService {
  readonly #d: ModerationDeps;
  readonly #now: () => number;
  /** Running timeouts by user, for the expiry job. */
  readonly #timeouts = new Map<string, number>();

  constructor(deps: ModerationDeps) {
    this.#d = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  async init(): Promise<void> {
    for (const m of await this.#d.accounts.listMembers()) {
      if (m.timeoutUntil !== null) this.#timeouts.set(m.userId, m.timeoutUntil);
    }
  }

  // ---- audit log -----------------------------------------------------------------------------

  async record(e: AuditInput, requestId?: string): Promise<void> {
    try {
      await this.#d.db.query
        .insertInto("audit_log")
        .values({
          id: newId(this.#now()),
          at: this.#now(),
          actor_id: e.actorId,
          action: e.action,
          target_type: e.targetType ?? null,
          target_id: e.targetId ?? null,
          reason: e.reason ?? null,
          data: JSON.stringify(e.data ?? {}),
        })
        .execute();
    } catch (err) {
      // An audit failure never undoes a moderation action that already happened; the log line is the fallback.
      this.#d.log.error({ err, action: e.action, requestId }, "moderation: audit entry could not be written");
    }
  }

  async list(q: {
    before?: string | undefined;
    limit: number;
    action?: string | undefined;
    actorId?: string | undefined;
    targetId?: string | undefined;
  }): Promise<AuditList> {
    let sel = this.#d.db.query.selectFrom("audit_log").selectAll();
    if (q.before) sel = sel.where("id", "<", q.before);
    if (q.action) sel = sel.where("action", "like", likePrefix(q.action));
    if (q.actorId) sel = sel.where("actor_id", "=", q.actorId);
    if (q.targetId) sel = sel.where("target_id", "=", q.targetId);
    const rows = await sel
      .orderBy("id", "desc")
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        at: new Date(r.at).toISOString(),
        actorId: r.actor_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        reason: r.reason,
        data: JSON.parse(r.data) as Record<string, unknown>,
      })),
      next: rows.length > q.limit ? page[page.length - 1]!.id : null,
    };
  }

  // ---- checks --------------------------------------------------------------------------------

  /** The target must be a member, not the actor, and below the actor in rank (11 §2.4). */
  async #target(actorId: string, targetId: string, kind: MemberAction): Promise<MemberRecord> {
    if (actorId === targetId) throw new AppError("PERMISSION_DENIED", "You cannot do that to yourself.");
    const member = await this.#d.accounts.getMember(targetId);
    if (!member) throw new AppError("NOT_FOUND", "No such member.");
    await this.#d.roles.authorizeOrThrow(actorId, {
      kind,
      member: await this.#d.roles.memberFacts(targetId),
    });
    return member;
  }

  #voice(): VoiceApi {
    if (!this.#d.voice) throw new AppError("FEATURE_DISABLED", "Voice is turned off on this server.");
    return this.#d.voice;
  }

  // ---- kick, ban -----------------------------------------------------------------------------

  async kick(
    actorId: string,
    targetId: string,
    reason: string | undefined,
    requestId?: string,
  ): Promise<void> {
    const t = await this.#target(actorId, targetId, "member.kick");
    await this.record(
      {
        actorId,
        action: "member.kick",
        targetType: "user",
        targetId,
        reason,
        data: { username: t.username },
      },
      requestId,
    );
    this.#d.events.emit("member.kicked", { userId: targetId }, requestId ? { requestId } : {});
    await this.#d.accounts.revokeAllSessions(targetId);
  }

  async ban(
    actorId: string,
    targetId: string,
    req: BanRequest,
    requestId?: string,
  ): Promise<{ purged: number }> {
    const t = await this.#target(actorId, targetId, "member.ban");
    const now = this.#now();
    await this.#d.db.query
      .insertInto("ban")
      .values({ user_id: targetId, reason: req.reason ?? null, banned_by: actorId, banned_at: now })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({ reason: req.reason ?? null, banned_by: actorId, banned_at: now }),
      )
      .execute();
    // The ban is stronger than a timeout, and the timeout's expiry must not fire later.
    this.#timeouts.delete(targetId);
    this.#d.events.emit("member.banned", { userId: targetId }, requestId ? { requestId } : {});
    await this.#d.accounts.revokeAllSessions(targetId);
    let purged = 0;
    if (req.purgeDays > 0 && this.#d.text) {
      purged = await this.#d.text.purgeAuthor(targetId, now - req.purgeDays * DAY, requestId);
    }
    await this.record(
      {
        actorId,
        action: "member.ban",
        targetType: "user",
        targetId,
        reason: req.reason,
        data: { username: t.username, purgeDays: req.purgeDays, purgedMessages: purged },
      },
      requestId,
    );
    return { purged };
  }

  async unban(actorId: string, targetId: string, requestId?: string): Promise<void> {
    await this.#d.roles.authorizeOrThrow(actorId, {
      kind: "member.ban",
      member: await this.#d.roles.memberFacts(targetId),
    });
    const gone = await this.#d.db.query
      .deleteFrom("ban")
      .where("user_id", "=", targetId)
      .returning("user_id")
      .executeTakeFirst();
    if (!gone) throw new AppError("NOT_FOUND", "That person is not banned.");
    await this.record({ actorId, action: "member.unban", targetType: "user", targetId }, requestId);
  }

  async isBanned(userId: string): Promise<{ reason: string | null } | null> {
    const row = await this.#d.db.query
      .selectFrom("ban")
      .select("reason")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return row ? { reason: row.reason } : null;
  }

  async listBans(): Promise<Ban[]> {
    const rows = await this.#d.db.query.selectFrom("ban").selectAll().orderBy("banned_at", "desc").execute();
    const users = await this.#d.accounts.getUsers(rows.map((r) => r.user_id));
    return rows.map((r) => ({
      userId: r.user_id,
      username: users.get(r.user_id)?.username ?? "(deleted)",
      displayName: users.get(r.user_id)?.displayName ?? "Deleted User",
      reason: r.reason,
      bannedBy: r.banned_by,
      bannedAt: new Date(r.banned_at).toISOString(),
    }));
  }

  // ---- timeout -------------------------------------------------------------------------------

  async timeout(actorId: string, targetId: string, req: TimeoutRequest, requestId?: string): Promise<void> {
    const t = await this.#target(actorId, targetId, "member.timeout");
    const until = req.durationSecs === null ? null : this.#now() + req.durationSecs * 1000;
    await this.#d.accounts.setTimeoutUntil(targetId, until);
    if (until === null) this.#timeouts.delete(targetId);
    else this.#timeouts.set(targetId, until);
    // Roles applies it to permissions and, through the bus, to live voice sessions (11 §2.6).
    await this.#d.roles.setTimeout(targetId, until);
    await this.record(
      {
        actorId,
        action: until === null ? "member.timeout.clear" : "member.timeout",
        targetType: "user",
        targetId,
        reason: req.reason,
        data: { username: t.username, ...(until !== null ? { until: new Date(until).toISOString() } : {}) },
      },
      requestId,
    );
  }

  /** Job: ends timeouts whose time is up, so permissions come back without anyone's action (11 §2.6). */
  async expireTimeouts(): Promise<void> {
    const now = this.#now();
    for (const [userId, until] of [...this.#timeouts]) {
      if (until > now) continue;
      this.#timeouts.delete(userId);
      await this.#d.accounts.setTimeoutUntil(userId, null);
      await this.#d.roles.setTimeout(userId, null);
    }
  }

  // ---- voice ---------------------------------------------------------------------------------

  async voiceState(actorId: string, targetId: string, req: VoiceModRequest, requestId?: string) {
    const t = await this.#target(actorId, targetId, "member.mute");
    const voice = this.#voice();
    const state = await voice.setServerState(targetId, req, actorId);
    await this.record(
      {
        actorId,
        action: "voice.server_state",
        targetType: "user",
        targetId,
        reason: req.reason,
        data: { username: t.username, ...state },
      },
      requestId,
    );
    return state;
  }

  async move(
    actorId: string,
    targetId: string,
    channelId: string,
    reason: string | undefined,
    requestId?: string,
  ): Promise<void> {
    const t = await this.#target(actorId, targetId, "member.move");
    const voice = this.#voice();
    const from = voice.whereIs(targetId);
    if (!from)
      throw new AppError("CONFLICT", "That person is not in a voice channel.", { reason: "not_in_voice" });
    // The destination is checked for the person being moved, not for the moderator (11 §3).
    await voice.checkMoveTarget(targetId, channelId);
    await voice.disconnect(targetId, "moved_by_moderator", channelId);
    await this.record(
      {
        actorId,
        action: "voice.move",
        targetType: "user",
        targetId,
        reason,
        data: { username: t.username, from, to: channelId },
      },
      requestId,
    );
  }

  async disconnect(
    actorId: string,
    targetId: string,
    reason: string | undefined,
    requestId?: string,
  ): Promise<void> {
    const t = await this.#target(actorId, targetId, "member.move");
    const voice = this.#voice();
    const from = voice.whereIs(targetId);
    if (!from)
      throw new AppError("CONFLICT", "That person is not in a voice channel.", { reason: "not_in_voice" });
    await voice.disconnect(targetId, "disconnected");
    await this.record(
      {
        actorId,
        action: "voice.disconnect",
        targetType: "user",
        targetId,
        reason,
        data: { username: t.username, from },
      },
      requestId,
    );
  }
}
