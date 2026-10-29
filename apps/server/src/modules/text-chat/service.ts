// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql, type Db } from "@tincan/db";
import type { Kv } from "@tincan/pubsub";
import {
  AppError,
  MENTION_CHANNEL_RE,
  MENTION_EVERYONE_RE,
  MENTION_ROLE_RE,
  MENTION_USER_RE,
  has,
  newId,
  type Attachment,
  type Message,
  type PermissionName,
} from "@tincan/shared";
import type { EventBus } from "../../framework/events.js";
import type { OutboxRegistrar } from "../../framework/outbox.js";
import type { GatewayRegistrar } from "../../framework/types.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import type { AccountsApi } from "../accounts/api.js";
import type { ChannelRecord, ChannelsApi } from "../channels/api.js";
import type { RolesApi } from "../roles/api.js";
import type { UploadsApi } from "../uploads/api.js";
import type { SearchDocument } from "./api.js";
import { FLAG_PINNED, type TextChatTables } from "./schema.js";

export interface TextChatSettings {
  maxContentChars: number;
  /** Messages per window per user and channel (07 §2.4: 10 per 10 s). */
  createRate: { max: number; windowSecs: number };
}

export interface TextChatDeps {
  db: Db<TextChatTables>;
  kv: Kv;
  roles: RolesApi;
  channels: ChannelsApi;
  accounts: AccountsApi;
  uploads: UploadsApi | undefined;
  gateway: GatewayRegistrar;
  events: EventBus;
  outbox: OutboxRegistrar;
  settings: TextChatSettings;
}

type MessageRow = TextChatTables["message"];

export interface MentionSet {
  users: string[];
  roles: string[];
  everyone: boolean;
}

/** Search text is the message minus mention tokens, which would only index IDs. */
export function searchText(content: string): string {
  return content
    .replace(MENTION_USER_RE, " ")
    .replace(MENTION_ROLE_RE, " ")
    .replace(MENTION_CHANNEL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EDIT_RATE = { max: 20, windowMs: 10_000 };
const NONCE_TTL_MS = 5 * 60_000;

export class TextChatService {
  readonly #d: TextChatDeps;

  constructor(deps: TextChatDeps) {
    this.#d = deps;
  }

  // ---- access --------------------------------------------------------------------------------

  /**
   * The channel, if it is an active text channel the actor can see; a channel they cannot see is
   * indistinguishable from one that does not exist (15: no leaking), one they can see but lack a
   * permission in answers PERMISSION_DENIED naming it.
   */
  async #channel(actorId: string, channelId: string, need: PermissionName[] = []): Promise<ChannelRecord> {
    const ch = await this.#d.channels.get(channelId);
    if (!ch || ch.archivedAt !== null || ch.type !== "text")
      throw new AppError("NOT_FOUND", "No such channel.");
    const p = await this.#d.roles.permissionsIn(actorId, channelId);
    if (!has(p, "VIEW_CHANNEL")) throw new AppError("NOT_FOUND", "No such channel.");
    for (const perm of need) {
      if (!has(p, perm)) {
        throw new AppError("PERMISSION_DENIED", "You do not have permission to do that here.", {
          missing: perm,
        });
      }
    }
    return ch;
  }

  // ---- mentions ------------------------------------------------------------------------------

  /** Validates the tokens in `content` against real members and roles; `@everyone` needs the permission. */
  async #mentions(content: string, canEveryone: boolean): Promise<MentionSet> {
    const userIds = new Set([...content.matchAll(MENTION_USER_RE)].map((m) => m[1]!));
    const roleIds = new Set([...content.matchAll(MENTION_ROLE_RE)].map((m) => m[1]!));
    const users = userIds.size ? [...(await this.#d.accounts.getUsers([...userIds])).keys()] : [];
    const known = roleIds.size
      ? new Set((await this.#d.roles.listRoles()).map((r) => r.id))
      : new Set<string>();
    return {
      users,
      roles: [...roleIds].filter((id) => known.has(id)),
      everyone: canEveryone && MENTION_EVERYONE_RE.test(content),
    };
  }

  #mentionRows(messageId: string, channelId: string, m: MentionSet): TextChatTables["message_mention"][] {
    return [
      ...m.users.map((id) => ({
        message_id: messageId,
        channel_id: channelId,
        target_type: "user",
        target_id: id,
      })),
      ...m.roles.map((id) => ({
        message_id: messageId,
        channel_id: channelId,
        target_type: "role",
        target_id: id,
      })),
      ...(m.everyone
        ? [{ message_id: messageId, channel_id: channelId, target_type: "everyone", target_id: "everyone" }]
        : []),
    ];
  }

  // ---- hydration -----------------------------------------------------------------------------

  async hydrate(rows: readonly MessageRow[], nonces?: ReadonlyMap<string, string>): Promise<Message[]> {
    if (rows.length === 0) return [];
    const db = this.#d.db;
    const ids = rows.map((r) => r.id);
    const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is string => x !== null))];
    const replies = replyIds.length
      ? await db.query
          .selectFrom("message")
          .select(["id", "author_id", "content", "deleted_at"])
          .where("id", "in", replyIds)
          .execute()
      : [];
    const users = await this.#d.accounts.getUsers([
      ...rows.map((r) => r.author_id),
      ...replies.map((r) => r.author_id),
    ]);
    const mentionRows = await db.query
      .selectFrom("message_mention")
      .select(["message_id", "target_type", "target_id"])
      .where("message_id", "in", ids)
      .execute();
    const attachments = this.#d.uploads
      ? await this.#d.uploads.forMessages(ids)
      : new Map<string, Attachment[]>();
    const replyById = new Map(replies.map((r) => [r.id, r]));

    return rows.map((r) => {
      const author = users.get(r.author_id);
      const reply = r.reply_to_id ? replyById.get(r.reply_to_id) : undefined;
      const mine = mentionRows.filter((m) => m.message_id === r.id);
      return {
        id: r.id,
        channelId: r.channel_id,
        authorId: r.author_id,
        author: author
          ? {
              id: author.id,
              username: author.username,
              displayName: author.displayName,
              avatarKey: author.avatarKey,
            }
          : null,
        content: r.content,
        replyToId: r.reply_to_id,
        reply: r.reply_to_id
          ? {
              id: r.reply_to_id,
              authorId: reply?.author_id ?? null,
              authorName: reply ? (users.get(reply.author_id)?.displayName ?? null) : null,
              excerpt: reply && reply.deleted_at === null ? searchText(reply.content).slice(0, 120) : "",
              deleted: !reply || reply.deleted_at !== null,
            }
          : null,
        createdAt: new Date(r.created_at).toISOString(),
        editedAt: r.edited_at === null ? null : new Date(r.edited_at).toISOString(),
        pinned: (r.flags & FLAG_PINNED) !== 0,
        attachments: attachments.get(r.id) ?? [],
        mentions: {
          users: mine.filter((m) => m.target_type === "user").map((m) => m.target_id),
          roles: mine.filter((m) => m.target_type === "role").map((m) => m.target_id),
          everyone: mine.some((m) => m.target_type === "everyone"),
        },
        nonce: nonces?.get(r.id) ?? null,
      };
    });
  }

  async getMessages(ids: readonly string[]): Promise<Message[]> {
    if (ids.length === 0) return [];
    const rows = await this.#d.db.query
      .selectFrom("message")
      .selectAll()
      .where("id", "in", [...ids])
      .where("deleted_at", "is", null)
      .execute();
    const byId = new Map((await this.hydrate(rows)).map((m) => [m.id, m]));
    return ids.map((id) => byId.get(id)).filter((m): m is Message => m !== undefined);
  }

  // ---- create --------------------------------------------------------------------------------

  async create(
    actorId: string,
    channelId: string,
    input: {
      content: string;
      replyToId?: string | undefined;
      attachmentIds?: string[] | undefined;
      nonce?: string | undefined;
    },
    requestId?: string,
  ): Promise<{ message: Message; created: boolean }> {
    const need: PermissionName[] = ["SEND_MESSAGES"];
    if (input.attachmentIds?.length) need.push("ATTACH_FILES");
    const channel = await this.#channel(actorId, channelId, need);

    // An idempotent retry returns the original, whatever the limits say now (07 §1).
    const nonceKey = input.nonce ? `nonce:${actorId}:${input.nonce}` : null;
    if (nonceKey) {
      const claimed = await this.#d.kv.set(nonceKey, "", { ttlMs: NONCE_TTL_MS, nx: true });
      if (!claimed) {
        const original = await this.#awaitNonce(nonceKey);
        if (original) {
          const [message] = await this.getMessages([original]);
          if (message) return { message: { ...message, nonce: input.nonce! }, created: false };
        }
        throw new AppError("CONFLICT", "That message is already being sent.");
      }
    }
    try {
      return await this.#create(actorId, channel, input, nonceKey, requestId);
    } catch (err) {
      if (nonceKey) await this.#d.kv.del(nonceKey); // a failed attempt can be retried with the same nonce
      throw err;
    }
  }

  async #awaitNonce(key: string): Promise<string | null> {
    for (let i = 0; i < 20; i++) {
      const v = await this.#d.kv.get(key);
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  async #create(
    actorId: string,
    channel: ChannelRecord,
    input: {
      content: string;
      replyToId?: string | undefined;
      attachmentIds?: string[] | undefined;
      nonce?: string | undefined;
    },
    nonceKey: string | null,
    requestId?: string,
  ): Promise<{ message: Message; created: boolean }> {
    const { maxContentChars, createRate } = this.#d.settings;
    const content = input.content.replace(/\r\n/g, "\n").trim();
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if ([...content].length > maxContentChars) {
      throw new AppError("VALIDATION_FAILED", `Messages can have at most ${maxContentChars} characters.`, {
        fields: { content: "too long" },
      });
    }
    if (content.length === 0 && attachmentIds.length === 0)
      throw new AppError("VALIDATION_FAILED", "A message needs some text or a file.", {
        fields: { content: "empty" },
      });
    if (attachmentIds.length > 0 && !this.#d.uploads)
      throw new AppError("FEATURE_DISABLED", "Uploads are turned off on this server.");

    const perms = await this.#d.roles.permissionsIn(actorId, channel.id);
    await enforceRateLimit(this.#d.kv, {
      key: `msg:${actorId}:${channel.id}`,
      max: createRate.max,
      windowMs: createRate.windowSecs * 1000,
    });
    const slowmode = channel.settings.slowmodeSecs ?? 0;
    if (slowmode > 0 && !has(perms, "MANAGE_MESSAGES")) {
      const key = `slow:${actorId}:${channel.id}`;
      if (!(await this.#d.kv.set(key, "1", { ttlMs: slowmode * 1000, nx: true }))) {
        throw new AppError("RATE_LIMITED", "Slowmode is on in this channel.", {
          retryAfterMs: (await this.#d.kv.ttl(key)) ?? slowmode * 1000,
        });
      }
    }

    let replyToId: string | null = null;
    if (input.replyToId) {
      const target = await this.#d.db.query
        .selectFrom("message")
        .select(["id", "channel_id", "deleted_at"])
        .where("id", "=", input.replyToId)
        .executeTakeFirst();
      if (!target || target.channel_id !== channel.id || target.deleted_at !== null)
        throw new AppError("VALIDATION_FAILED", "The message you are replying to is not in this channel.", {
          fields: { replyToId: "not found" },
        });
      replyToId = target.id;
    }

    const mentions = await this.#mentions(content, has(perms, "MENTION_EVERYONE"));
    const now = Date.now();
    const row: MessageRow = {
      id: newId(now),
      channel_id: channel.id,
      author_id: actorId,
      content,
      reply_to_id: replyToId,
      created_at: now,
      edited_at: null,
      deleted_at: null,
      flags: 0,
    };
    await this.#d.db.transaction(async (tx) => {
      await tx.query.insertInto("message").values(row).execute();
      const mrows = this.#mentionRows(row.id, channel.id, mentions);
      if (mrows.length) await tx.query.insertInto("message_mention").values(mrows).execute();
      if (attachmentIds.length)
        await this.#d.uploads!.attach(tx, {
          ids: attachmentIds,
          uploaderId: actorId,
          messageId: row.id,
          channelId: channel.id,
        });
      await this.#d.outbox.append(
        tx,
        "search.message",
        { op: "upsert", id: row.id, channelId: channel.id, authorId: actorId, text: searchText(content) },
        requestId,
      );
    });
    if (nonceKey) await this.#d.kv.set(nonceKey, row.id, { ttlMs: NONCE_TTL_MS });

    const [message] = await this.hydrate([row], input.nonce ? new Map([[row.id, input.nonce]]) : undefined);
    this.#d.gateway.dispatchToChannel(channel.id, "MESSAGE_CREATE", { message });
    this.#d.events.emit(
      "message.created",
      { messageId: row.id, channelId: channel.id, authorId: actorId },
      requestId ? { requestId } : {},
    );
    return { message: message!, created: true };
  }

  // ---- edit, delete, pin ---------------------------------------------------------------------

  async #row(channelId: string, messageId: string): Promise<MessageRow> {
    const row = await this.#d.db.query
      .selectFrom("message")
      .selectAll()
      .where("id", "=", messageId)
      .where("channel_id", "=", channelId)
      .executeTakeFirst();
    if (!row || row.deleted_at !== null) throw new AppError("NOT_FOUND", "No such message.");
    return row;
  }

  async edit(
    actorId: string,
    channelId: string,
    messageId: string,
    newContent: string,
    requestId?: string,
  ): Promise<Message> {
    await this.#channel(actorId, channelId, ["SEND_MESSAGES"]);
    await enforceRateLimit(this.#d.kv, { key: `edit:${actorId}`, ...EDIT_RATE });
    const row = await this.#row(channelId, messageId);
    if (row.author_id !== actorId)
      throw new AppError("PERMISSION_DENIED", "You can only edit your own messages.");
    const content = newContent.replace(/\r\n/g, "\n").trim();
    if ([...content].length > this.#d.settings.maxContentChars)
      throw new AppError("VALIDATION_FAILED", "That message is too long.", {
        fields: { content: "too long" },
      });
    if (content.length === 0)
      throw new AppError("VALIDATION_FAILED", "A message cannot be empty.", { fields: { content: "empty" } });
    const perms = await this.#d.roles.permissionsIn(actorId, channelId);
    const mentions = await this.#mentions(content, has(perms, "MENTION_EVERYONE"));
    const now = Date.now();
    await this.#d.db.transaction(async (tx) => {
      await tx.query
        .updateTable("message")
        .set({ content, edited_at: now })
        .where("id", "=", messageId)
        .execute();
      await tx.query.deleteFrom("message_mention").where("message_id", "=", messageId).execute();
      const mrows = this.#mentionRows(messageId, channelId, mentions);
      if (mrows.length) await tx.query.insertInto("message_mention").values(mrows).execute();
      await this.#d.outbox.append(
        tx,
        "search.message",
        { op: "upsert", id: messageId, channelId, authorId: row.author_id, text: searchText(content) },
        requestId,
      );
    });
    const [message] = await this.getMessages([messageId]);
    this.#d.gateway.dispatchToChannel(channelId, "MESSAGE_UPDATE", { message });
    return message!;
  }

  async remove(actorId: string, channelId: string, messageId: string, requestId?: string): Promise<void> {
    await this.#channel(actorId, channelId);
    await enforceRateLimit(this.#d.kv, { key: `edit:${actorId}`, ...EDIT_RATE });
    const row = await this.#row(channelId, messageId);
    if (row.author_id !== actorId) {
      await this.#channel(actorId, channelId, ["MANAGE_MESSAGES"]);
    }
    await this.#d.db.transaction(async (tx) => {
      await tx.query
        .updateTable("message")
        .set({ deleted_at: Date.now() })
        .where("id", "=", messageId)
        .execute();
      await this.#d.outbox.append(tx, "search.message", { op: "remove", id: messageId }, requestId);
    });
    this.#d.gateway.dispatchToChannel(channelId, "MESSAGE_DELETE", { channelId, messageId });
    this.#d.events.emit("message.deleted", { messageId, channelId });
  }

  async setPinned(actorId: string, channelId: string, messageId: string, pinned: boolean): Promise<void> {
    await this.#channel(actorId, channelId, ["MANAGE_MESSAGES"]);
    const row = await this.#row(channelId, messageId);
    const flags = pinned ? row.flags | FLAG_PINNED : row.flags & ~FLAG_PINNED;
    if (flags === row.flags) return;
    await this.#d.db.query.updateTable("message").set({ flags }).where("id", "=", messageId).execute();
    this.#d.gateway.dispatchToChannel(channelId, "MESSAGE_PIN", { channelId, messageId, pinned });
  }

  async pins(actorId: string, channelId: string): Promise<Message[]> {
    await this.#channel(actorId, channelId, ["READ_HISTORY"]);
    const rows = await this.#d.db.query
      .selectFrom("message")
      .selectAll()
      .where("channel_id", "=", channelId)
      .where("deleted_at", "is", null)
      .where(sql<number>`flags & ${FLAG_PINNED}`, "=", FLAG_PINNED)
      .orderBy("id", "desc")
      .limit(200)
      .execute();
    return this.hydrate(rows.reverse());
  }

  // ---- history (07 §2.3) ---------------------------------------------------------------------

  async history(
    actorId: string,
    channelId: string,
    q: {
      before?: string | undefined;
      after?: string | undefined;
      around?: string | undefined;
      limit: number;
    },
  ): Promise<Message[]> {
    const channel = await this.#channel(actorId, channelId);
    const perms = await this.#d.roles.permissionsIn(actorId, channelId);
    // Without READ_HISTORY a member sees new messages as they arrive and nothing older (11 §2.2).
    if (!has(perms, "READ_HISTORY")) return [];
    const base = () =>
      this.#d.db.query
        .selectFrom("message")
        .selectAll()
        .where("channel_id", "=", channel.id)
        .where("deleted_at", "is", null);
    let rows: MessageRow[];
    if (q.around) {
      const half = Math.max(1, Math.floor(q.limit / 2));
      const older = await base().where("id", "<", q.around).orderBy("id", "desc").limit(half).execute();
      const newer = await base()
        .where("id", ">=", q.around)
        .orderBy("id", "asc")
        .limit(q.limit - older.length)
        .execute();
      rows = [...older.reverse(), ...newer];
    } else if (q.after) {
      rows = await base().where("id", ">", q.after).orderBy("id", "asc").limit(q.limit).execute();
    } else if (q.before) {
      rows = (
        await base().where("id", "<", q.before).orderBy("id", "desc").limit(q.limit).execute()
      ).reverse();
    } else {
      rows = (await base().orderBy("id", "desc").limit(q.limit).execute()).reverse();
    }
    return this.hydrate(rows);
  }

  // ---- typing (07 §4.6, 18 T10: gateway only) ------------------------------------------------

  async typing(actorId: string, channelId: string): Promise<void> {
    await this.#channel(actorId, channelId, ["SEND_MESSAGES"]);
    // 1 per 3 s per channel, coalesced silently.
    if (!(await this.#d.kv.set(`typing:${actorId}:${channelId}`, "1", { ttlMs: 3000, nx: true }))) return;
    this.#d.gateway.dispatchToChannel(
      channelId,
      "TYPING_START",
      { channelId, userId: actorId, at: Date.now() },
      actorId,
    );
  }

  // ---- reads for other modules ---------------------------------------------------------------

  async latestMessageIds(channelIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const channelId of channelIds) {
      const r = await this.#d.db.query
        .selectFrom("message")
        .select("id")
        .where("channel_id", "=", channelId)
        .where("deleted_at", "is", null)
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();
      if (r) out.set(channelId, r.id);
    }
    return out;
  }

  async mentionCounts(
    userId: string,
    roleIds: readonly string[],
    entries: readonly { channelId: string; afterId: string | null }[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const { channelId, afterId } of entries) {
      const r = await this.#d.db.query
        .selectFrom("message_mention as mm")
        .innerJoin("message as m", "m.id", "mm.message_id")
        .select((eb) => eb.fn.count<number>("mm.message_id").distinct().as("n"))
        .where("mm.channel_id", "=", channelId)
        .where("mm.message_id", ">", afterId ?? "")
        .where("m.deleted_at", "is", null)
        .where("m.author_id", "!=", userId)
        .where((eb) =>
          eb.or([
            eb.and([eb("mm.target_type", "=", "user"), eb("mm.target_id", "=", userId)]),
            ...(roleIds.length
              ? [eb.and([eb("mm.target_type", "=", "role"), eb("mm.target_id", "in", [...roleIds])])]
              : []),
            eb("mm.target_type", "=", "everyone"),
          ]),
        )
        .executeTakeFirst();
      out.set(channelId, Number(r?.n ?? 0));
    }
    return out;
  }

  async messageExists(channelId: string, messageId: string): Promise<boolean> {
    const r = await this.#d.db.query
      .selectFrom("message")
      .select("id")
      .where("id", "=", messageId)
      .where("channel_id", "=", channelId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return r !== undefined;
  }

  async existingIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.#d.db.query
      .selectFrom("message")
      .select("id")
      .where("id", "in", [...ids])
      .where("deleted_at", "is", null)
      .execute();
    return new Set(rows.map((r) => r.id));
  }

  async documents(afterId: string | null, limit: number, tx?: Db<unknown>): Promise<SearchDocument[]> {
    const db = tx ? tx.as<TextChatTables>() : this.#d.db;
    const rows = await db.query
      .selectFrom("message")
      .select(["id", "channel_id", "author_id", "content"])
      .where("deleted_at", "is", null)
      .where("id", ">", afterId ?? "")
      .orderBy("id")
      .limit(limit)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      authorId: r.author_id,
      text: searchText(r.content),
    }));
  }
}
