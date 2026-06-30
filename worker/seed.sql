-- Optional sample data for demos / first-run.
-- Load:    wrangler d1 execute poker-tracker --remote --file worker/seed.sql
-- Remove:  wrangler d1 execute poker-tracker --remote --command "DELETE FROM buyins WHERE id LIKE 'seed-%'; DELETE FROM session_players WHERE id LIKE 'seed-%'; DELETE FROM sessions WHERE id LIKE 'seed-%'; DELETE FROM casino_visits WHERE id LIKE 'seed-%';"

-- ── Sessions ──────────────────────────────────────────────────────
INSERT OR IGNORE INTO sessions (id, name, status, created_at) VALUES
  ('seed-s1', 'Friday Night',  'settled', '2026-05-02 20:00:00'),
  ('seed-s2', 'Saturday Cash', 'settled', '2026-05-09 20:00:00'),
  ('seed-s3', 'Big Game',      'settled', '2026-05-23 20:00:00'),
  ('seed-s4', 'This Week',     'active',  '2026-05-30 20:00:00');

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
INSERT OR IGNORE INTO casino_visits (id, casino_name, buy_in, cash_out, games, notes, created_at) VALUES
  ('seed-c1', 'Crown Casino', 200, 350, 'poker,blackjack', 'Good night',     '2026-05-10 21:00:00'),
  ('seed-c2', 'Crown Casino', 300, 120, 'roulette',        'Cold table',     '2026-05-18 21:00:00'),
  ('seed-c3', 'The Star',     150, 200, 'poker',           'Small win',      '2026-05-25 21:00:00');
