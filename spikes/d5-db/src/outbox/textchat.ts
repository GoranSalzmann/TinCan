// `text-chat` use cases: each write appends its search.message outbox row in
// the same transaction (06 §3.9).
import { monotonicFactory } from "ulidx";
import type { Db, Tx } from "./db.js";
import { appendOutbox } from "./outbox.js";
import type { DocumentSource, SearchPayload } from "./search.js";

const ulid = monotonicFactory();
const TOPIC = "search.message";

export async function createMessage(db: Db, m: { channelId: string; authorId: string; content: string }, requestId?: string) {
  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insertInto("message").values({ id, channel_id: m.channelId, author_id: m.authorId, content: m.content, reply_to_id: null, created_at: Date.now(), edited_at: null, deleted_at: null }).execute();
    await appendOutbox(tx, TOPIC, { op: "upsert", id, channelId: m.channelId, authorId: m.authorId, text: m.content } satisfies SearchPayload, requestId);
  });
  return id;
}

export async function editMessage(db: Db, id: string, content: string) {
  await db.transaction(async (tx) => {
    const m = await tx.updateTable("message").set({ content, edited_at: Date.now() }).where("id", "=", id).where("deleted_at", "is", null)
      .returning(["channel_id", "author_id"]).executeTakeFirst();
    if (!m) return;
    await appendOutbox(tx, TOPIC, { op: "upsert", id, channelId: m.channel_id, authorId: m.author_id, text: content } satisfies SearchPayload);
  });
}

export async function deleteMessage(db: Db, id: string) {
  await db.transaction(async (tx) => {
    const r = await tx.updateTable("message").set({ deleted_at: Date.now() }).where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
    if (r.numUpdatedRows === 0n) return;
    await appendOutbox(tx, TOPIC, { op: "remove", id } satisfies SearchPayload);
  });
}

export const messageSource: DocumentSource = {
  async page(tx: Tx, afterId, limit) {
    let q = tx.selectFrom("message").select(["id", "channel_id", "author_id", "content"]).where("deleted_at", "is", null).orderBy("id").limit(limit);
    if (afterId) q = q.where("id", ">", afterId);
    return (await q.execute()).map((r) => ({ id: r.id, channelId: r.channel_id, authorId: r.author_id, text: r.content }));
  },
};
