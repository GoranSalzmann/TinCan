// Typed queries with Drizzle (types come from the TS schema; no codegen for queries).
// `tsc --noEmit` passing proves every @ts-expect-error below is a real error.
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, desc, and, isNull, sql } from "drizzle-orm";
import { message, searchDoc } from "./drizzle-schema.js";

declare const db: ReturnType<typeof drizzle>;

export function demo() {
  const rows = db.select({ id: message.id, content: message.content, createdAt: message.createdAt }).from(message)
    .where(and(eq(message.channelId, "c1"), isNull(message.deletedAt))).orderBy(desc(message.id)).limit(50).all();
  const createdAt: number = rows[0]!.createdAt;
  // @ts-expect-error not selected
  rows[0]!.authorId;
  // @ts-expect-error unknown column
  message.contnet;
  // @ts-expect-error wrong value type for content
  db.insert(message).values({ id: "x", channelId: "c", authorId: "a", content: 42, createdAt: 1 }).run();
  // @ts-expect-error createdAt is required
  db.insert(message).values({ id: "x", channelId: "c", authorId: "a", content: "hi" }).run();
  // @ts-expect-error comparing a text column with a number
  db.select().from(message).where(eq(message.channelId, 5)).all();

  // FTS5: no virtual-table support in sqlite-core, so the whole statement is raw
  // SQL and the row type is an unchecked assertion.
  const hits = db.all<{ message_id: string; score: number }>(
    sql`SELECT message_id, bm25(message_fts) AS score FROM message_fts WHERE message_fts MATCH ${"the"} ORDER BY rowid DESC LIMIT 10`);
  const score: number = hits[0]!.score;

  const joined = db.select({ rowid: searchDoc.ftsRowid, content: message.content }).from(searchDoc)
    .innerJoin(message, eq(message.id, searchDoc.messageId)).limit(1).all();
  const rowid: number = joined[0]!.rowid;

  // Note: sync driver, so these are plain values. On the async sqlite-proxy
  // driver every call above needs `await`; the types are otherwise the same.
  return { createdAt, score, rowid };
}
