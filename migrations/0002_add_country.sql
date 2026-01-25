-- Add country column for geo-based trending queries
-- Stores ISO 3166-1 alpha-2 country codes (e.g., 'US', 'GB', 'JP')

ALTER TABLE search_queries ADD COLUMN country TEXT;

-- Index for country-based trending queries lookup
CREATE INDEX IF NOT EXISTS idx_search_queries_country_date_count
  ON search_queries(country, date DESC, search_count DESC);
