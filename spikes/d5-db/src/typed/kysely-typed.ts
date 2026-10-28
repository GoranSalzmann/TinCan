// Typed queries with Kysely and hand-written table types (no codegen).
// `tsc --noEmit` passing proves every @ts-expect-error below is a real error.
import { Kysely, sql } from "kysely";
import type { DB, SearchTables, TextChatTables } from "../outbox/db.js";

declare const db: Kysely<DB>;

export async function demo() {
  const rows = await db.selectFrom("message").select(["id", "content", "created_at"])
    .where("channel_id", "=", "c1").where("deleted_at", "is", null).orderBy("id", "desc").limit(50).execute();
  const createdAt: number = rows[0]!.created_at;
  // @ts-expect-error not selected, so not on the result type
  rows[0]!.author_id;
  // @ts-expect-error unknown column
  await db.selectFrom("message").select(["contnet"]).execute();
  // @ts-expect-error wrong value type for content
  await db.insertInto("message").values({ id: "x", channel_id: "c", author_id: "a", content: 42, reply_to_id: null, created_at: 1, edited_at: null, deleted_at: null }).execute();
  // @ts-expect-error created_at is required
  await db.insertInto("message").values({ id: "x", channel_id: "c", author_id: "a", content: "hi", reply_to_id: null, edited_at: null, deleted_at: null }).execute();
  // @ts-expect-error comparing a text column with a number
  await db.selectFrom("message").selectAll().where("channel_id", "=", 5).execute();

  // FTS5: MATCH and bm25() go through sql``, but the select list stays typed.
  const hits = await db.selectFrom("message_fts")
    .select(["message_id", sql<number>`bm25(message_fts)`.as("score")])
    .where(sql<boolean>`message_fts MATCH ${"the"}`).orderBy("rowid", "desc").limit(10).execute();
  const score: number = hits[0]!.score;
  const id: string = hits[0]!.message_id;

  // Joins are typed across tables.
  const joined = await db.selectFrom("search_doc as d").innerJoin("message as m", "m.id", "d.message_id")
    .select(["d.fts_rowid", "m.content"]).limit(1).execute();
  const rowid: number = joined[0]!.fts_rowid;

  // Module boundaries: a module given only its own slice cannot name other modules' tables.
  const searchModuleDb: Kysely<SearchTables> = db; // assignable without a cast
  // @ts-expect-error `message` belongs to text-chat, not search
  searchModuleDb.selectFrom("message");
  const textChatDb: Kysely<TextChatTables> = db;
  // @ts-expect-error `search_doc` belongs to search
  textChatDb.selectFrom("search_doc");

  return { createdAt, score, id, rowid };
}
