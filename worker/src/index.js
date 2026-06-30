/* ─────────────────────────────────────────────────────────────
   Poker Tracker — Cloudflare Worker API
   Handles all CRUD for sessions, session_players, and buyins.
   Database: Cloudflare D1 (SQLite)
   ───────────────────────────────────────────────────────────── */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ok    = d          => Response.json(d,               { headers: CORS });
const err   = (m, s=500) => Response.json({ error: m },   { status: s, headers: CORS });

// Whitelist of columns a client may PATCH per table. Anything else is dropped,
// so the column names interpolated into SQL can never come from user input.
const ALLOWED_FIELDS = {
  sessions:      ['name', 'status', 'notes'],
  casino_visits: ['casino_name', 'buy_in', 'cash_out', 'games', 'notes'],
};

// Builds a safe "col = ?, col = ?" clause + ordered values from a request body.
// Returns null when the body has no whitelisted fields.
function buildUpdate(table, body) {
  const keys = Object.keys(body).filter(k => ALLOWED_FIELDS[table].includes(k));
  if (!keys.length) return null;
  return { sets: keys.map(k => `${k} = ?`).join(', '), values: keys.map(k => body[k]) };
}

// ── Input validation predicates ───────────────────────────────────
// The API handles money, so every write is guarded before it touches D1.
const isStr         = v => typeof v === 'string' && v.trim().length > 0;
const isPos         = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isMoneyOrNull = v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const isDateStr     = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export default {
  async fetch(request, env) {
    const { pathname: path } = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Auth check runs before DB — no dependency on D1
    if (path === '/api/auth' && method === 'POST') {
      try {
        const { password } = await request.json();
        // Two roles share one lock screen. LOCK_PASSWORD = full-access admin.
        // USER_PASSWORD = optional restricted role (hides destructive actions
        // client-side). If USER_PASSWORD is never set, only admin works and the
        // app behaves exactly as a single-password lock.
        if (password && password === env.LOCK_PASSWORD) {
          return ok({ success: true, role: 'admin' });
        }
        if (password && env.USER_PASSWORD && password === env.USER_PASSWORD) {
          return ok({ success: true, role: 'user' });
        }
        await new Promise(r => setTimeout(r, 800));
        return err('Incorrect password', 401);
      } catch (e) {
        return err(e.message);
      }
    }

    await env.DB.exec('PRAGMA foreign_keys = ON');

    try {

      /* ── GET /api/sessions ─────────────────────────────────────
         All sessions with nested session_players + buyins          */
      if (path === '/api/sessions' && method === 'GET') {
        const { results: sessions } = await env.DB.prepare(
          'SELECT * FROM sessions ORDER BY created_at DESC'
        ).all();

        if (!sessions.length) return ok([]);

        const { results: players } = await env.DB.prepare(
          `SELECT * FROM session_players
           WHERE session_id IN (${sessions.map(() => '?').join(',')})
           ORDER BY created_at ASC`
        ).bind(...sessions.map(s => s.id)).all();

        const buyinsMap = {};
        if (players.length) {
          const { results: buyins } = await env.DB.prepare(
            `SELECT * FROM buyins
             WHERE session_player_id IN (${players.map(() => '?').join(',')})
             ORDER BY created_at ASC`
          ).bind(...players.map(p => p.id)).all();
          for (const b of buyins) {
            buyinsMap[b.session_player_id] ??= [];
            buyinsMap[b.session_player_id].push(b);
          }
        }

        const playersMap = {};
        for (const p of players) {
          playersMap[p.session_id] ??= [];
          playersMap[p.session_id].push({ ...p, buyins: buyinsMap[p.id] ?? [] });
        }

        return ok(sessions.map(s => ({ ...s, session_players: playersMap[s.id] ?? [] })));
      }

      /* ── POST /api/sessions ────────────────────────────────────
         Create a new session                                       */
      if (path === '/api/sessions' && method === 'POST') {
        const { name, created_at } = await request.json();
        if (!isStr(name)) return err('Session name is required', 400);
        if (created_at !== undefined && !isDateStr(created_at)) return err('Invalid date', 400);
        const id = crypto.randomUUID();
        if (created_at) {
          await env.DB.prepare(
            'INSERT INTO sessions (id, name, status, created_at) VALUES (?, ?, ?, ?)'
          ).bind(id, name, 'active', created_at).run();
        } else {
          await env.DB.prepare(
            'INSERT INTO sessions (id, name, status) VALUES (?, ?, ?)'
          ).bind(id, name, 'active').run();
        }
        return ok(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first());
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);

      /* ── PATCH /api/sessions/:id ───────────────────────────────
         Update name or status                                      */
      if (sessionMatch && method === 'PATCH') {
        const id   = sessionMatch[1];
        const body = await request.json();
        if ('status' in body && body.status !== 'active' && body.status !== 'settled')
          return err('Invalid status', 400);
        if ('name' in body && !isStr(body.name)) return err('Name cannot be empty', 400);
        const upd  = buildUpdate('sessions', body);
        if (!upd) return err('No valid fields to update', 400);
        await env.DB.prepare(`UPDATE sessions SET ${upd.sets} WHERE id = ?`)
          .bind(...upd.values, id).run();
        return ok(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first());
      }

      /* ── DELETE /api/sessions/:id ──────────────────────────────
         Delete session + cascade to players + buyins               */
      if (sessionMatch && method === 'DELETE') {
        const id = sessionMatch[1];
        const { results: players } = await env.DB.prepare(
          'SELECT id FROM session_players WHERE session_id = ?'
        ).bind(id).all();
        for (const p of players) {
          await env.DB.prepare('DELETE FROM buyins WHERE session_player_id = ?').bind(p.id).run();
        }
        await env.DB.prepare('DELETE FROM session_players WHERE session_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
        return ok({ success: true });
      }

      /* ── GET /api/sessions/:id/players ─────────────────────────
         Players + buyins for one session                           */
      const playersMatch = path.match(/^\/api\/sessions\/([^/]+)\/players$/);
      if (playersMatch && method === 'GET') {
        const sessionId = playersMatch[1];
        const { results: players } = await env.DB.prepare(
          'SELECT * FROM session_players WHERE session_id = ? ORDER BY created_at ASC'
        ).bind(sessionId).all();

        if (!players.length) return ok([]);

        const { results: buyins } = await env.DB.prepare(
          `SELECT * FROM buyins
           WHERE session_player_id IN (${players.map(() => '?').join(',')})
           ORDER BY created_at ASC`
        ).bind(...players.map(p => p.id)).all();

        const buyinsMap = {};
        for (const b of buyins) {
          buyinsMap[b.session_player_id] ??= [];
          buyinsMap[b.session_player_id].push(b);
        }

        return ok(players.map(p => ({ ...p, buyins: buyinsMap[p.id] ?? [] })));
      }

      /* ── POST /api/session-players ─────────────────────────────
         Add a player to a session                                  */
      if (path === '/api/session-players' && method === 'POST') {
        const { session_id, player_name } = await request.json();
        if (!isStr(session_id))  return err('session_id is required', 400);
        if (!isStr(player_name)) return err('Player name is required', 400);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO session_players (id, session_id, player_name) VALUES (?, ?, ?)'
        ).bind(id, session_id, player_name).run();
        return ok(await env.DB.prepare('SELECT * FROM session_players WHERE id = ?').bind(id).first());
      }

      const spMatch = path.match(/^\/api\/session-players\/([^/]+)$/);

      /* ── PATCH /api/session-players/:id ───────────────────────
         Update final_chips on settle                               */
      if (spMatch && method === 'PATCH') {
        const id = spMatch[1];
        const { final_chips } = await request.json();
        if (!isMoneyOrNull(final_chips)) return err('final_chips must be zero or more, or null', 400);
        await env.DB.prepare('UPDATE session_players SET final_chips = ? WHERE id = ?')
          .bind(final_chips, id).run();
        return ok({ success: true });
      }

      /* ── DELETE /api/session-players/:id ──────────────────────
         Remove player + cascade to buyins                          */
      if (spMatch && method === 'DELETE') {
        const id = spMatch[1];
        await env.DB.prepare('DELETE FROM buyins WHERE session_player_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM session_players WHERE id = ?').bind(id).run();
        return ok({ success: true });
      }

      /* ── POST /api/buyins ──────────────────────────────────────
         Add a buy-in                                               */
      if (path === '/api/buyins' && method === 'POST') {
        const { session_player_id, amount } = await request.json();
        if (!isStr(session_player_id)) return err('session_player_id is required', 400);
        if (!isPos(amount))            return err('Buy-in amount must be a positive number', 400);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO buyins (id, session_player_id, amount) VALUES (?, ?, ?)'
        ).bind(id, session_player_id, amount).run();
        return ok({ id, session_player_id, amount });
      }

      const buyinMatch = path.match(/^\/api\/buyins\/([^/]+)$/);

      /* ── PATCH /api/buyins/:id ─────────────────────────────────
         Edit a buy-in amount                                       */
      if (buyinMatch && method === 'PATCH') {
        const id = buyinMatch[1];
        const { amount } = await request.json();
        if (!isPos(amount)) return err('Buy-in amount must be a positive number', 400);
        await env.DB.prepare('UPDATE buyins SET amount = ? WHERE id = ?').bind(amount, id).run();
        return ok({ success: true });
      }

      /* ── DELETE /api/buyins/:id ────────────────────────────────
         Remove a buy-in entry                                      */
      if (buyinMatch && method === 'DELETE') {
        const id = buyinMatch[1];
        await env.DB.prepare('DELETE FROM buyins WHERE id = ?').bind(id).run();
        return ok({ success: true });
      }

      /* ── GET /api/stats ────────────────────────────────────────
         Settled session stats for leaderboard, records, dashboard  */
      if (path === '/api/stats' && method === 'GET') {
        const { results } = await env.DB.prepare(`
          SELECT sp.id         AS sp_id,
                 sp.player_name,
                 sp.final_chips,
                 s.name        AS session_name,
                 s.created_at  AS session_date,
                 b.amount      AS buyin_amount
          FROM   session_players sp
          INNER  JOIN sessions s ON s.id = sp.session_id
          LEFT   JOIN buyins   b ON b.session_player_id = sp.id
          WHERE  s.status = 'settled'
            AND  sp.final_chips IS NOT NULL
          ORDER  BY s.created_at DESC
        `).all();

        const map = {};
        for (const row of results) {
          if (!map[row.sp_id]) {
            map[row.sp_id] = {
              player_name:  row.player_name,
              final_chips:  row.final_chips,
              session_name: row.session_name,
              session_date: row.session_date,
              buyins:       [],
            };
          }
          if (row.buyin_amount !== null) {
            map[row.sp_id].buyins.push({ amount: row.buyin_amount });
          }
        }

        return ok(Object.values(map));
      }

      /* ── GET /api/players/:name/history ───────────────────────
         All settled sessions for one player                        */
      const playerHistoryMatch = path.match(/^\/api\/players\/(.+)\/history$/);
      if (playerHistoryMatch && method === 'GET') {
        const playerName = decodeURIComponent(playerHistoryMatch[1]);

        const { results } = await env.DB.prepare(`
          SELECT sp.id         AS sp_id,
                 sp.final_chips,
                 s.name        AS session_name,
                 s.created_at  AS session_date,
                 b.amount      AS buyin_amount
          FROM   session_players sp
          INNER  JOIN sessions s ON s.id = sp.session_id
          LEFT   JOIN buyins   b ON b.session_player_id = sp.id
          WHERE  s.status = 'settled'
            AND  sp.final_chips IS NOT NULL
            AND  LOWER(sp.player_name) = LOWER(?)
          ORDER  BY s.created_at DESC
        `).bind(playerName).all();

        const map = {};
        for (const row of results) {
          if (!map[row.sp_id]) {
            map[row.sp_id] = {
              session_name: row.session_name,
              session_date: row.session_date,
              final_chips:  row.final_chips,
              buyins:       [],
            };
          }
          if (row.buyin_amount !== null) {
            map[row.sp_id].buyins.push({ amount: row.buyin_amount });
          }
        }

        return ok(Object.values(map));
      }

      /* ── GET /api/casino/visits ────────────────────────────────
         All casino visits, newest first                            */
      if (path === '/api/casino/visits' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM casino_visits ORDER BY created_at DESC'
        ).all();
        return ok(results);
      }

      /* ── POST /api/casino/visits ───────────────────────────────
         Log a new casino visit                                     */
      if (path === '/api/casino/visits' && method === 'POST') {
        const { casino_name, buy_in, cash_out, games, notes, created_at } = await request.json();
        if (!isStr(casino_name))                              return err('Casino name is required', 400);
        if (!isPos(buy_in))                                   return err('Buy-in must be a positive number', 400);
        if (cash_out !== undefined && !isMoneyOrNull(cash_out)) return err('Cash-out must be zero or more', 400);
        if (created_at !== undefined && !isDateStr(created_at)) return err('Invalid date', 400);
        const id = crypto.randomUUID();
        if (created_at) {
          await env.DB.prepare(
            'INSERT INTO casino_visits (id, casino_name, buy_in, cash_out, games, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, casino_name, buy_in, cash_out ?? null, games ?? '', notes ?? null, created_at).run();
        } else {
          await env.DB.prepare(
            'INSERT INTO casino_visits (id, casino_name, buy_in, cash_out, games, notes) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(id, casino_name, buy_in, cash_out ?? null, games ?? '', notes ?? null).run();
        }
        return ok(await env.DB.prepare('SELECT * FROM casino_visits WHERE id = ?').bind(id).first());
      }

      const casinoVisitMatch = path.match(/^\/api\/casino\/visits\/([^/]+)$/);

      /* ── PATCH /api/casino/visits/:id ──────────────────────────
         Update a casino visit (settle cash_out, add notes)         */
      if (casinoVisitMatch && method === 'PATCH') {
        const id   = casinoVisitMatch[1];
        const body = await request.json();
        if ('casino_name' in body && !isStr(body.casino_name)) return err('Casino name cannot be empty', 400);
        if ('buy_in' in body && !isPos(body.buy_in))           return err('Buy-in must be a positive number', 400);
        if ('cash_out' in body && !isMoneyOrNull(body.cash_out)) return err('Cash-out must be zero or more', 400);
        const upd  = buildUpdate('casino_visits', body);
        if (!upd) return err('No valid fields to update', 400);
        await env.DB.prepare(`UPDATE casino_visits SET ${upd.sets} WHERE id = ?`)
          .bind(...upd.values, id).run();
        return ok(await env.DB.prepare('SELECT * FROM casino_visits WHERE id = ?').bind(id).first());
      }

      /* ── DELETE /api/casino/visits/:id ─────────────────────────
         Remove a casino visit                                      */
      if (casinoVisitMatch && method === 'DELETE') {
        const id = casinoVisitMatch[1];
        await env.DB.prepare('DELETE FROM casino_visits WHERE id = ?').bind(id).run();
        return ok({ success: true });
      }

      /* ── GET /api/casino/stats ─────────────────────────────────
         Aggregated stats for the casino dashboard                  */
      if (path === '/api/casino/stats' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM casino_visits WHERE cash_out IS NOT NULL ORDER BY created_at ASC'
        ).all();
        return ok(results);
      }

      return err('Not found', 404);

    } catch (e) {
      return err(e.message);
    }
  },
};
