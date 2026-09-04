-- Preserve existing rows while enabling atomic per-country query aggregation.
CREATE TABLE search_queries_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_hash TEXT NOT NULL,
  query_normalized TEXT NOT NULL,
  search_count INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  country TEXT NOT NULL DEFAULT '',
  UNIQUE(query_hash, date, country)
);
INSERT INTO search_queries_new
  (id, query_hash, query_normalized, search_count, date, created_at, updated_at, country)
SELECT id, query_hash, query_normalized, search_count, date, created_at, updated_at,
       COALESCE(UPPER(country), '') FROM search_queries;
DROP TABLE search_queries;
ALTER TABLE search_queries_new RENAME TO search_queries;
CREATE INDEX idx_search_queries_date_count ON search_queries(date DESC, search_count DESC);
CREATE INDEX idx_search_queries_hash_date ON search_queries(query_hash, date);
CREATE INDEX idx_search_queries_country_date_count
  ON search_queries(country, date DESC, search_count DESC);
