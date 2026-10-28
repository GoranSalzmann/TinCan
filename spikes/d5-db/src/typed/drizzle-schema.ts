// Drizzle schema for the same tables. drizzle-kit reads this file to generate SQL migrations.
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const message = sqliteTable("message", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  authorId: text("author_id").notNull(),
  content: text("content").notNull(),
  replyToId: text("reply_to_id"),
  createdAt: integer("created_at").notNull(),
  editedAt: integer("edited_at"),
  deletedAt: integer("deleted_at"),
  flags: integer("flags").notNull().default(0),
}, (t) => [index("message_channel").on(t.channelId, t.id), index("message_author").on(t.authorId, t.id)]);

export const outbox = sqliteTable("outbox", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  payload: text("payload").notNull(),
  requestId: text("request_id"),
  createdAt: integer("created_at").notNull(),
});

export const searchDoc = sqliteTable("search_doc", {
  ftsRowid: integer("fts_rowid").primaryKey(),
  messageId: text("message_id").notNull().unique(),
});
// message_fts is an FTS5 virtual table: sqlite-core cannot declare it, so
// drizzle-kit cannot generate it; it lives in a hand-written custom migration.
