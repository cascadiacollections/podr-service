import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DB_PATH = process.env.DB_PATH ?? './data/podr.db';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS stations_cache (
  query     TEXT PRIMARY KEY,
  results   TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_cache (
  url       TEXT PRIMARY KEY,
  data      TEXT NOT NULL,
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
`;

/**
 * Open (and initialize) the SQLite database.
 *
 * The DB file is created on demand. `:memory:` is honored for tests.
 */
export function openDatabase(path: string = DB_PATH): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
