-- Migration 0001 — multi-tenant foundation (TODO Phase 1)
-- Moves the app from "one shared dataset behind a password" toward
-- per-group data ownership. This migration is NON-DESTRUCTIVE: it only
-- adds new tables and NULLABLE columns, so every existing row keeps
-- working and the current (unauthenticated) API behaves exactly as before.
--
-- Apply once against an EXISTING database with:
--   wrangler d1 execute poker-tracker --remote --file worker/migrations/0001_multitenant.sql
--
-- Fresh databases get the same shape from schema.sql directly — do not run
-- both against a brand-new DB (the ALTERs below would fail on columns that
-- already exist).

PRAGMA foreign_keys = ON;

-- ── Ownership unit ────────────────────────────────────────────────
-- A "group" is a poker crew that shares one ledger. This is the ownership
-- unit for the whole app (per-group, not per-individual) — see TODO Phase 1.
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- An authenticated identity. Populated by the auth provider in Phase 2;
-- defined here so Phase 1 ownership columns have something to reference.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Which users belong to which group, and their role within it.
-- Role replaces the global admin/user lock-screen concept in Phase 2.
CREATE TABLE IF NOT EXISTS group_members (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',     -- 'owner' | 'admin' | 'member'
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (group_id, user_id)
);

-- A single-use code/link that adds a user to a group.
CREATE TABLE IF NOT EXISTS invites (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  code          TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'member',    -- role granted on accept
  invited_email TEXT,                              -- optional: pre-addressed invite
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at   TEXT,
  expires_at    TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- ── Attach existing data to a group ───────────────────────────────
-- NULLABLE on purpose: legacy rows (group_id IS NULL) stay readable. A later
-- migration backfills a default group and then enforces NOT NULL once every
-- query in worker/src/index.js is group-scoped (TODO Phase 1, step 4).
ALTER TABLE sessions      ADD COLUMN group_id TEXT REFERENCES groups(id);
ALTER TABLE casino_visits ADD COLUMN group_id TEXT REFERENCES groups(id);

CREATE INDEX IF NOT EXISTS idx_sessions_group       ON sessions(group_id);
CREATE INDEX IF NOT EXISTS idx_casino_visits_group  ON casino_visits(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group  ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user   ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_invites_group        ON invites(group_id);
