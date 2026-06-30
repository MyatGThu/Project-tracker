-- Poker Tracker — Cloudflare D1 (SQLite) schema
-- Apply with:
--   wrangler d1 execute poker-tracker --remote --file worker/schema.sql

PRAGMA foreign_keys = ON;

-- ── Multi-tenant foundation (TODO Phase 1) ────────────────────────
-- A "group" is the ownership unit: a poker crew that shares one ledger.
-- On an existing database these come from worker/migrations/0001_multitenant.sql;
-- they live here too so a fresh DB gets the full shape in one pass.
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,                 -- auth provider subject (Auth0 `sub`) = sole identity key
  email       TEXT,                             -- nullable + non-unique, cosmetic only; never used to link accounts
  name        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',     -- 'owner' | 'admin' | 'member'
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  code          TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'member',
  invited_email TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at   TEXT,
  expires_at    TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'settled'
  notes       TEXT,
  group_id    TEXT NOT NULL REFERENCES groups(id),   -- every session belongs to a group
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
  group_id    TEXT NOT NULL REFERENCES groups(id),   -- every visit belongs to a group
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Indexes that the group-scoped queries (TODO Phase 1, step 4) will rely on.
CREATE INDEX IF NOT EXISTS idx_sessions_group       ON sessions(group_id);
CREATE INDEX IF NOT EXISTS idx_casino_visits_group  ON casino_visits(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group  ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user   ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_invites_group        ON invites(group_id);
