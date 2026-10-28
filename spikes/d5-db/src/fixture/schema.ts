// Fixture schema: `message` as in 06 §3.5, `message_fts` exactly as in 06 §3.9,
// `outbox` as in 06 §3.14, plus `search_doc`, the search module's own
// message_id -> FTS rowid map (see outbox/search.ts for why it is needed).
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to_id TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  flags INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS message_channel ON message(channel_id, id);
CREATE INDEX IF NOT EXISTS message_author ON message(author_id, id);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  request_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(content, channel_id UNINDEXED, message_id UNINDEXED);
CREATE TABLE IF NOT EXISTS search_doc (
  fts_rowid INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE
);
`;
