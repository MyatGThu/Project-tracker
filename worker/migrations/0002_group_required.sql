-- Migration 0002 — make group_id mandatory (TODO Phase 1 close-out)
--
-- Follows the retirement of password mode: every session/visit now belongs to a
-- group, so group_id becomes NOT NULL. Any rows left over from the old
-- password mode (group_id IS NULL) are parked in a single "Legacy (unassigned)"
-- group first so the NOT NULL rebuild can't fail. That group has no members, so
-- its data is invisible through the API until an owner is added to it directly
-- (e.g. INSERT a group_members row) — intended as a safety net, not recovery.
--
-- Apply once against a database that has already run 0001_multitenant.sql:
--   wrangler d1 execute poker-tracker --remote --file worker/migrations/0002_group_required.sql
--
-- Fresh databases get NOT NULL straight from schema.sql and must NOT run this.

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- Park orphaned rows in a default group (only created if such rows exist).
INSERT OR IGNORE INTO groups (id, name)
  SELECT 'legacy-default-group', 'Legacy (unassigned)'
  WHERE EXISTS (SELECT 1 FROM sessions      WHERE group_id IS NULL)
     OR EXISTS (SELECT 1 FROM casino_visits WHERE group_id IS NULL);
UPDATE sessions      SET group_id = 'legacy-default-group' WHERE group_id IS NULL;
UPDATE casino_visits SET group_id = 'legacy-default-group' WHERE group_id IS NULL;

-- Rebuild sessions with NOT NULL group_id (SQLite can't ALTER a column to
-- add NOT NULL). session_players' FK references sessions by name, so copying
-- the same ids across the swap preserves it (foreign_keys is OFF for the swap).
CREATE TABLE sessions_new (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  notes       TEXT,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  created_at  TEXT DEFAULT (datetime('now'))
);
INSERT INTO sessions_new (id, name, status, notes, group_id, created_at)
  SELECT id, name, status, notes, group_id, created_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

-- Rebuild casino_visits with NOT NULL group_id.
CREATE TABLE casino_visits_new (
  id          TEXT PRIMARY KEY,
  casino_name TEXT NOT NULL DEFAULT 'Casino',
  buy_in      REAL NOT NULL,
  cash_out    REAL,
  games       TEXT DEFAULT '',
  notes       TEXT,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  created_at  TEXT DEFAULT (datetime('now'))
);
INSERT INTO casino_visits_new (id, casino_name, buy_in, cash_out, games, notes, group_id, created_at)
  SELECT id, casino_name, buy_in, cash_out, games, notes, group_id, created_at FROM casino_visits;
DROP TABLE casino_visits;
ALTER TABLE casino_visits_new RENAME TO casino_visits;

-- Recreate the indexes that were dropped with the old tables.
CREATE INDEX IF NOT EXISTS idx_sessions_group      ON sessions(group_id);
CREATE INDEX IF NOT EXISTS idx_casino_visits_group ON casino_visits(group_id);

COMMIT;
PRAGMA foreign_keys = ON;
