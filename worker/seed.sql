-- Optional sample data for demos / first-run.
-- Load:    wrangler d1 execute poker-tracker --remote --file worker/seed.sql
-- Remove:  wrangler d1 execute poker-tracker --remote --command "DELETE FROM buyins WHERE id LIKE 'seed-%'; DELETE FROM session_players WHERE id LIKE 'seed-%'; DELETE FROM sessions WHERE id LIKE 'seed-%'; DELETE FROM casino_visits WHERE id LIKE 'seed-%'; DELETE FROM group_members WHERE id LIKE 'seed-%'; DELETE FROM groups WHERE id = 'seed-group';"
--
-- The data belongs to a demo group ('seed-group'). To SEE it, sign in once
-- (creates your user row), then make yourself a member and switch to it:
--   wrangler d1 execute poker-tracker --remote --command \
--     "INSERT INTO group_members (id, group_id, user_id, role) VALUES ('seed-me', 'seed-group', '<YOUR_AUTH0_SUB>', 'owner');"
-- (find your sub via GET /api/me) then pick "Demo Crew" in Account → switch group.

-- ── Demo group (owns all the seed data) ───────────────────────────
INSERT OR IGNORE INTO groups (id, name) VALUES ('seed-group', 'Demo Crew');

-- ── Sessions ──────────────────────────────────────────────────────
INSERT OR IGNORE INTO sessions (id, name, status, group_id, created_at) VALUES
  ('seed-s1', 'Friday Night',  'settled', 'seed-group', '2026-05-02 20:00:00'),
  ('seed-s2', 'Saturday Cash', 'settled', 'seed-group', '2026-05-09 20:00:00'),
  ('seed-s3', 'Big Game',      'settled', 'seed-group', '2026-05-23 20:00:00'),
  ('seed-s4', 'This Week',     'active',  'seed-group', '2026-05-30 20:00:00');

-- ── Session players (final_chips set for settled sessions) ────────
INSERT OR IGNORE INTO session_players (id, session_id, player_name, final_chips, created_at) VALUES
  ('seed-s1-p1', 'seed-s1', 'Alex',   160, '2026-05-02 20:01:00'),
  ('seed-s1-p2', 'seed-s1', 'Sam',     40, '2026-05-02 20:01:00'),
  ('seed-s1-p3', 'seed-s1', 'Jordan',  50, '2026-05-02 20:01:00'),
  ('seed-s2-p1', 'seed-s2', 'Alex',    50, '2026-05-09 20:01:00'),
  ('seed-s2-p2', 'seed-s2', 'Casey',  180, '2026-05-09 20:01:00'),
  ('seed-s2-p3', 'seed-s2', 'Taylor',  20, '2026-05-09 20:01:00'),
  ('seed-s3-p1', 'seed-s3', 'Sam',    320, '2026-05-23 20:01:00'),
  ('seed-s3-p2', 'seed-s3', 'Jordan',  40, '2026-05-23 20:01:00'),
  ('seed-s3-p3', 'seed-s3', 'Alex',    40, '2026-05-23 20:01:00'),
  ('seed-s4-p1', 'seed-s4', 'Alex',   NULL, '2026-05-30 20:01:00'),
  ('seed-s4-p2', 'seed-s4', 'Sam',    NULL, '2026-05-30 20:01:00');

-- ── Buy-ins ───────────────────────────────────────────────────────
INSERT OR IGNORE INTO buyins (id, session_player_id, amount, created_at) VALUES
  ('seed-s1-p1-b1', 'seed-s1-p1', 100, '2026-05-02 20:02:00'),
  ('seed-s1-p2-b1', 'seed-s1-p2', 100, '2026-05-02 20:02:00'),
  ('seed-s1-p3-b1', 'seed-s1-p3',  50, '2026-05-02 20:02:00'),
  ('seed-s2-p1-b1', 'seed-s2-p1', 100, '2026-05-09 20:02:00'),
  ('seed-s2-p2-b1', 'seed-s2-p2', 100, '2026-05-09 20:02:00'),
  ('seed-s2-p3-b1', 'seed-s2-p3',  50, '2026-05-09 20:02:00'),
  ('seed-s3-p1-b1', 'seed-s3-p1', 200, '2026-05-23 20:02:00'),
  ('seed-s3-p2-b1', 'seed-s3-p2', 100, '2026-05-23 20:02:00'),
  ('seed-s3-p3-b1', 'seed-s3-p3', 100, '2026-05-23 20:02:00'),
  ('seed-s4-p1-b1', 'seed-s4-p1',  50, '2026-05-30 20:02:00'),
  ('seed-s4-p2-b1', 'seed-s4-p2',  50, '2026-05-30 20:02:00');

-- ── Casino visits ─────────────────────────────────────────────────
INSERT OR IGNORE INTO casino_visits (id, casino_name, buy_in, cash_out, games, notes, group_id, created_at) VALUES
  ('seed-c1', 'Crown Casino', 200, 350, 'poker,blackjack', 'Good night', 'seed-group', '2026-05-10 21:00:00'),
  ('seed-c2', 'Crown Casino', 300, 120, 'roulette',        'Cold table', 'seed-group', '2026-05-18 21:00:00'),
  ('seed-c3', 'The Star',     150, 200, 'poker',           'Small win',  'seed-group', '2026-05-25 21:00:00');
