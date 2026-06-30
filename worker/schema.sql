-- Poker Tracker — Cloudflare D1 (SQLite) schema
-- Apply with:
--   wrangler d1 execute poker-tracker --remote --file worker/schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'settled'
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_players (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_name  TEXT NOT NULL,
  final_chips  REAL,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buyins (
  id                 TEXT PRIMARY KEY,
  session_player_id  TEXT NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
  amount             REAL NOT NULL,
  created_at         TEXT DEFAULT (datetime('now'))
);

-- Casino mode: standalone visit log
CREATE TABLE IF NOT EXISTS casino_visits (
  id          TEXT PRIMARY KEY,
  casino_name TEXT NOT NULL DEFAULT 'Casino',
  buy_in      REAL NOT NULL,
  cash_out    REAL,
  games       TEXT DEFAULT '',
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
