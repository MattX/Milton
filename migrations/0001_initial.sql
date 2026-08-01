PRAGMA foreign_keys = ON;

CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_url TEXT NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'indexed', 'failed')),
  extraction_error TEXT,
  first_posted_at TEXT NOT NULL,
  last_posted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  message_url TEXT NOT NULL,
  UNIQUE(article_id, message_id)
);

CREATE INDEX occurrences_article_posted
  ON occurrences(article_id, posted_at DESC);
CREATE INDEX occurrences_channel_message
  ON occurrences(channel_id, message_id);

CREATE TABLE channel_cursors (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  parent_id TEXT,
  channel_name TEXT NOT NULL,
  is_thread INTEGER NOT NULL DEFAULT 0,
  live_after_id TEXT,
  backfill_before_id TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  initialized INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE extraction_jobs (
  article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'enqueued', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX extraction_jobs_dispatch
  ON extraction_jobs(status, priority, created_at);

CREATE TABLE browser_usage (
  usage_date TEXT PRIMARY KEY,
  milliseconds INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO system_state(key, value, updated_at)
VALUES ('backfill_enabled', '0', datetime('now'));

CREATE VIRTUAL TABLE articles_fts USING fts5(
  title,
  domain,
  body,
  content='articles',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, domain, body)
  VALUES (new.id, new.title, new.domain, new.body);
END;

CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, domain, body)
  VALUES ('delete', old.id, old.title, old.domain, old.body);
END;

CREATE TRIGGER articles_au AFTER UPDATE OF title, domain, body ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, domain, body)
  VALUES ('delete', old.id, old.title, old.domain, old.body);
  INSERT INTO articles_fts(rowid, title, domain, body)
  VALUES (new.id, new.title, new.domain, new.body);
END;
