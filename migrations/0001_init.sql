-- podr-service schema
-- Applied automatically by src/db.ts on boot. Kept here as the canonical
-- reference for the SQLite layout consumed by all handlers.

CREATE TABLE IF NOT EXISTS stations_cache (
  query     TEXT PRIMARY KEY,
  results   TEXT NOT NULL,         -- JSON-encoded MediaItem[]
  cached_at INTEGER NOT NULL       -- unix seconds
);

CREATE TABLE IF NOT EXISTS feed_cache (
  url       TEXT PRIMARY KEY,
  data      TEXT NOT NULL,         -- JSON-encoded ParsedFeed (incl. guids)
  cached_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  uri         TEXT PRIMARY KEY,
  title       TEXT,
  last_played INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS subscriptions (
  uri         TEXT PRIMARY KEY,
  title       TEXT,
  artwork_url TEXT,
  added_at    INTEGER NOT NULL
);
