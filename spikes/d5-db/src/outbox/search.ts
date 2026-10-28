// `search` module: SearchIndex on FTS5, fed only by outbox payloads (it never
// reads text-chat tables). Why `search_doc` exists: 06 §3.9 keys FTS rows by an
// UNINDEXED message_id column, and FTS5 cannot look up an UNINDEXED column, so
// an idempotent upsert/remove by message_id would scan the whole index (see
// bench/blocking.ts "delete by UNINDEXED message_id"). search_doc maps
// message_id -> FTS rowid so both are point operations.
import { sql } from "kysely";
import type { Db, Tx } from "./db.js";
import type { Handler } from "./outbox.js";

export interface SearchDoc { id: string; channelId: string; authorId: string; text: string }
export type SearchPayload = ({ op: "upsert" } & SearchDoc) | { op: "remove"; id: string };

export async function upsert(tx: Tx, d: SearchDoc): Promise<void> {
  const doc = await tx.selectFrom("search_doc").select("fts_rowid").where("message_id", "=", d.id).executeTakeFirst();
  let rowid: number;
  if (doc) {
    rowid = doc.fts_rowid;
    await sql`DELETE FROM message_fts WHERE rowid = ${rowid}`.execute(tx);
  } else {
    rowid = Number((await tx.insertInto("search_doc").values({ message_id: d.id }).executeTakeFirstOrThrow()).insertId);
  }
  await tx.insertInto("message_fts").values({ rowid, content: d.text, channel_id: d.channelId, message_id: d.id }).execute();
}

export async function remove(tx: Tx, id: string): Promise<void> {
  const doc = await tx.selectFrom("search_doc").select("fts_rowid").where("message_id", "=", id).executeTakeFirst();
  if (!doc) return;
  await sql`DELETE FROM message_fts WHERE rowid = ${doc.fts_rowid}`.execute(tx);
  await tx.deleteFrom("search_doc").where("fts_rowid", "=", doc.fts_rowid).execute();
}

export const searchHandlers: Record<string, Handler> = {
  "search.message": (tx, p: SearchPayload) => (p.op === "upsert" ? upsert(tx, p) : remove(tx, p.id)),
};

// Bounded query: LIMIT, newest first, filtered to the caller's visible channels.
export function query(db: Db, q: string, channelIds: string[], limit = 50) {
  return db.query
    .selectFrom("message_fts")
    .select(["message_id", "channel_id", sql<string>`snippet(message_fts, 0, '[', ']', '…', 12)`.as("snippet")])
    .where(sql<boolean>`message_fts MATCH ${q}`)
    .where("channel_id", "in", channelIds)
    .orderBy("rowid", "desc")
    .limit(limit)
    .execute();
}

// Provided by text-chat; the search module only sees SearchDocs.
export interface DocumentSource {
  page(tx: Tx, afterId: string | null, limit: number): Promise<SearchDoc[]>;
}

// `tincan search reindex`: online, in short transactions, yielding between them.
// Phase 1 clears every FTS row and search_doc row up to the max rowid at start
// (docs the drain adds meanwhile get higher rowids and survive). FTS5 does not
// use a rowid *range* constraint (a range DELETE scans the whole table: 49
// rows/s on the 4 GB fixture), so rowids come from b-tree ranges on the
// docsize shadow table and search_doc, and each FTS row is deleted by `rowid = ?`.
// Phase 2 re-reads every live message inside the same transaction that writes
// it, so a concurrent edit either lands before the read or has a later outbox
// row applied after.
export async function reindex(db: Db, source: DocumentSource, opts: { batch?: number; onStep?: (phase: string, n: number) => void } = {}) {
  const batch = opts.batch ?? 500;
  const yieldLoop = () => new Promise((r) => setImmediate(r));
  const maxOf = (q: string) => (db.sqlite.prepare(q).get() as { m: number | null }).m ?? 0;
  const max = Math.max(maxOf("SELECT max(fts_rowid) m FROM search_doc"), maxOf("SELECT max(id) m FROM message_fts_docsize"));
  let cleared = 0;
  for (const [table, col] of [["message_fts_docsize", "id"], ["search_doc", "fts_rowid"]] as const) {
    let after = 0;
    for (;;) {
      const n: number = await db.transaction(async (tx) => {
        const { rows } = await sql<{ r: number }>`SELECT ${sql.ref(col)} r FROM ${sql.table(table)} WHERE ${sql.ref(col)} > ${after} AND ${sql.ref(col)} <= ${max} ORDER BY ${sql.ref(col)} LIMIT ${batch}`.execute(tx);
        for (const { r } of rows) {
          await sql`DELETE FROM message_fts WHERE rowid = ${r}`.execute(tx);
          await tx.deleteFrom("search_doc").where("fts_rowid", "=", r).execute();
        }
        if (rows.length) after = rows[rows.length - 1]!.r;
        return rows.length;
      });
      if (n === 0) break;
      cleared += n;
      opts.onStep?.("clear", cleared);
      await yieldLoop();
    }
  }
  let cursor: string | null = null;
  let indexed = 0;
  for (;;) {
    const n: number = await db.transaction(async (tx) => {
      const docs = await source.page(tx, cursor, batch);
      for (const d of docs) await upsert(tx, d);
      if (docs.length) cursor = docs[docs.length - 1]!.id;
      return docs.length;
    });
    if (n === 0) break;
    indexed += n;
    opts.onStep?.("index", indexed);
    await yieldLoop();
  }
  return { cleared, indexed };
}
