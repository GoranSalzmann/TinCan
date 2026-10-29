// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql, type Db } from "@tincan/db";
import type { Kv } from "@tincan/pubsub";
import { AppError, has, type Message } from "@tincan/shared";
import type { OutboxRegistrar } from "../../framework/outbox.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import type { AccountsApi } from "../accounts/api.js";
import type { ChannelsApi } from "../channels/api.js";
import type { RolesApi } from "../roles/api.js";
import type { TextChatApi } from "../text-chat/api.js";
import type { ReindexResult } from "./api.js";
import type { SearchTables } from "./schema.js";

/** Payload of the `search.message` outbox topic, written by text-chat in the message's own transaction. */
export type SearchEvent =
  | { op: "upsert"; id: string; channelId: string; authorId: string; text: string }
  | { op: "remove"; id: string };

export const SEARCH_TOPIC = "search.message";
/** Shorter prefixes match too much: 'ka*' took 350 ms against 25 ms for 'kalo*' on 3.4M messages (05 §3.1). */
const MIN_PREFIX = 3;
const MAX_TERMS = 8;
/** Relevance ranks only the newest matches; ranking every hit took up to 4.5 s (D5). */
const RANK_WINDOW = 1000;
const MAX_ROWID = Number.MAX_SAFE_INTEGER;

export interface SearchDeps {
  db: Db<SearchTables>;
  kv: Kv;
  roles: RolesApi;
  channels: ChannelsApi;
  accounts: AccountsApi;
  text: TextChatApi;
  outbox: OutboxRegistrar;
}

/** Turns what a person typed into a safe FTS5 expression: quoted words, the last one a prefix if long enough. */
export function ftsTerms(q: string): string[] {
  const words = [...q.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)]
    .map((m) => m[0])
    .filter((w) => w.length >= 2);
  return words
    .slice(0, MAX_TERMS)
    .map((w, i, all) => (i === all.length - 1 && w.length >= MIN_PREFIX ? `"${w}"*` : `"${w}"`));
}

export function matchExpression(terms: string[], channelIds: readonly string[], authorId?: string): string {
  const parts = [
    `content : (${terms.join(" ")})`,
    `chan : (${channelIds.map((c) => `"${c}"`).join(" OR ")})`,
  ];
  if (authorId) parts.push(`author : ("${authorId}")`);
  return parts.join(" AND ");
}

export class SearchService {
  readonly #d: SearchDeps;

  constructor(deps: SearchDeps) {
    this.#d = deps;
  }

  // ---- indexing (outbox consumer; runs inside the drain's transaction, idempotent) ----------------

  async apply(ev: SearchEvent, rawTx: Db<unknown>): Promise<void> {
    const tx = rawTx.as<SearchTables>();
    const existing = await tx.query
      .selectFrom("search_doc")
      .select("fts_rowid")
      .where("message_id", "=", ev.id)
      .executeTakeFirst();
    if (ev.op === "remove") {
      if (!existing) return;
      await sql`DELETE FROM message_fts WHERE rowid = ${existing.fts_rowid}`.execute(tx.query);
      await tx.query.deleteFrom("search_doc").where("fts_rowid", "=", existing.fts_rowid).execute();
      return;
    }
    if (existing) {
      // Edits keep their rowid, so paging by rowid stays stable.
      await sql`UPDATE message_fts SET content = ${ev.text}, chan = ${ev.channelId}, author = ${ev.authorId}
                WHERE rowid = ${existing.fts_rowid}`.execute(tx.query);
      return;
    }
    await sql`INSERT INTO message_fts (content, chan, author, message_id)
              VALUES (${ev.text}, ${ev.channelId}, ${ev.authorId}, ${ev.id})`.execute(tx.query);
    const { rows } = await sql<{ id: number }>`SELECT last_insert_rowid() AS id`.execute(tx.query);
    await tx.query.insertInto("search_doc").values({ fts_rowid: rows[0]!.id, message_id: ev.id }).execute();
  }

  // ---- querying ------------------------------------------------------------------------------

  /** Text channels whose history the member may read, right now (06 §3.9: never index-time permission). */
  async searchableChannels(userId: string): Promise<Set<string>> {
    const text = new Set(
      (await this.#d.channels.list())
        .filter((c) => c.type === "text" && c.archivedAt === null)
        .map((c) => c.id),
    );
    const out = new Set<string>();
    for (const id of await this.#d.roles.visibleChannelIds(userId)) {
      if (!text.has(id)) continue;
      if (has(await this.#d.roles.permissionsIn(userId, id), "READ_HISTORY")) out.add(id);
    }
    return out;
  }

  async search(
    userId: string,
    q: {
      q: string;
      channelId?: string | undefined;
      authorId?: string | undefined;
      sort: "newest" | "relevance";
      cursor?: string | undefined;
      limit: number;
    },
  ): Promise<{ items: Message[]; nextCursor: string | null }> {
    await enforceRateLimit(this.#d.kv, { key: `search:${userId}`, max: 30, windowMs: 60_000 });
    const terms = ftsTerms(q.q);
    if (terms.length === 0) return { items: [], nextCursor: null };
    let channels = await this.searchableChannels(userId);
    if (q.channelId !== undefined) {
      // A channel you cannot read answers like one that has no hits.
      channels = channels.has(q.channelId) ? new Set([q.channelId]) : new Set();
    }
    if (channels.size === 0) return { items: [], nextCursor: null };
    const match = matchExpression(terms, [...channels], q.authorId);

    let hits: { rid: number; mid: string }[];
    let nextCursor: string | null = null;
    if (q.sort === "relevance") {
      const offset = Math.max(0, Number.parseInt(q.cursor ?? "0", 10) || 0);
      if (offset >= RANK_WINDOW) return { items: [], nextCursor: null };
      const take = Math.min(q.limit, RANK_WINDOW - offset);
      hits = await this.#d.db.readOnly<{ rid: number; mid: string }>(
        `SELECT rowid AS rid, message_id AS mid FROM message_fts
          WHERE message_fts MATCH ?
            AND rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ? ORDER BY rowid DESC LIMIT ${RANK_WINDOW})
          ORDER BY bm25(message_fts) LIMIT ? OFFSET ?`,
        [match, match, take + 1, offset],
      );
      if (hits.length > take) {
        hits = hits.slice(0, take);
        nextCursor = String(offset + take);
      }
    } else {
      const before = Math.min(MAX_ROWID, Number.parseInt(q.cursor ?? "", 10) || MAX_ROWID);
      hits = await this.#d.db.readOnly<{ rid: number; mid: string }>(
        `SELECT rowid AS rid, message_id AS mid FROM message_fts
          WHERE message_fts MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
        [match, before, q.limit + 1],
      );
      if (hits.length > q.limit) {
        hits = hits.slice(0, q.limit);
        nextCursor = String(hits[hits.length - 1]!.rid);
      }
    }

    // The index can trail a delete by a moment; hydration drops what is gone, and the channel is
    // checked once more against what the member can read now.
    const messages = await this.#d.text.getMessages(hits.map((h) => h.mid));
    return { items: messages.filter((m) => channels.has(m.channelId)), nextCursor };
  }

  // ---- reindex (18 T29) ----------------------------------------------------------------------

  async reindex(
    opts: { batchSize?: number; onProgress?: (done: number) => void } = {},
  ): Promise<ReindexResult> {
    const batch = opts.batchSize ?? 500;
    if (!this.#d.outbox.isConsumed(SEARCH_TOPIC))
      throw new AppError("INTERNAL", "search: the outbox consumer is not registered");
    let queued = 0;
    let after: string | null = null;
    // Each batch reads and queues inside one transaction, so a message edited meanwhile is queued
    // before or after its edit row, never with stale text behind a newer row.
    for (;;) {
      const docs = await this.#d.db.transaction(async (tx) => {
        const rows = await this.#d.text.documents(after, batch, tx);
        for (const d of rows) {
          await this.#d.outbox.append(
            tx,
            SEARCH_TOPIC,
            {
              op: "upsert",
              id: d.id,
              channelId: d.channelId,
              authorId: d.authorId,
              text: d.text,
            } satisfies SearchEvent,
            "reindex",
          );
        }
        return rows;
      });
      if (docs.length === 0) break;
      queued += docs.length;
      after = docs[docs.length - 1]!.id;
      opts.onProgress?.(queued);
      await new Promise<void>((r) => setImmediate(r));
    }

    // Entries whose message is gone (deleted while the index was damaged) are removed.
    let removed = 0;
    let cursor = 0;
    for (;;) {
      const page = await this.#d.db.query
        .selectFrom("search_doc")
        .selectAll()
        .where("fts_rowid", ">", cursor)
        .orderBy("fts_rowid")
        .limit(batch)
        .execute();
      if (page.length === 0) break;
      cursor = page[page.length - 1]!.fts_rowid;
      const live = await this.#d.text.existingIds(page.map((p) => p.message_id));
      const gone = page.filter((p) => !live.has(p.message_id));
      if (gone.length > 0) {
        await this.#d.db.transaction(async (tx) => {
          for (const g of gone)
            await this.#d.outbox.append(
              tx,
              SEARCH_TOPIC,
              { op: "remove", id: g.message_id } satisfies SearchEvent,
              "reindex",
            );
        });
        removed += gone.length;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
    return { queued, removed };
  }
}
