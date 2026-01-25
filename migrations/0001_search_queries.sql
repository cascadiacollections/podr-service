-- Search queries tracking for trending feature
-- Tracks normalized queries with daily aggregation

CREATE TABLE IF NOT EXISTS search_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_hash TEXT NOT NULL,           -- SHA-256 hash of normalized query (privacy)
  query_normalized TEXT NOT NULL,     -- Lowercase, trimmed query for display
  search_count INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,                 -- YYYY-MM-DD for daily aggregation
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(query_hash, date)            -- One row per query per day
);

-- Index for trending queries lookup (most searched today/this week)
CREATE INDEX IF NOT EXISTS idx_search_queries_date_count
  ON search_queries(date DESC, search_count DESC);

-- Index for query hash lookup (upsert performance)
CREATE INDEX IF NOT EXISTS idx_search_queries_hash_date
  ON search_queries(query_hash, date);
