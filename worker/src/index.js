/* ─────────────────────────────────────────────────────────────
   Poker Tracker — Cloudflare Worker API
   Handles all CRUD for sessions, session_players, and buyins.
   Database: Cloudflare D1 (SQLite)

   Multi-user (TODO Phase 1 + 2): when Auth0 is configured (AUTH0_DOMAIN +
   AUTH0_AUDIENCE secrets), every /api route below requires a verified Bearer
   token and is scoped to the caller's active group. When those secrets are
   absent the API behaves exactly as the original single-shared-dataset app.
   ───────────────────────────────────────────────────────────── */

import { authEnabled, authenticate } from './auth.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  // Authorization + X-Group-Id must be allowed for the browser preflight to
  // pass once Auth0 is on (bearer token + active-group selector).
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Group-Id',
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

// ── Group scoping helpers ─────────────────────────────────────────
const INVITE_ROLES = ['admin', 'member'];   // 'owner' is never granted via invite

// Canonical "this role has admin powers in its group" predicate (owner|admin).
const isGroupAdmin = role => role === 'owner' || role === 'admin';

// WHERE fragment that constrains a query to the caller's group. When gid is
// null (auth disabled) it matches every row, preserving legacy behaviour.
const groupFilter = (gid, col = 'group_id') =>
  gid ? { clause: `${col} = ?`, args: [gid] } : { clause: '1 = 1', args: [] };

// Build an INSERT from a {column: value} map, skipping undefined values. Column
// names are caller-supplied literals (never user input), values are bound. This
// lets group_id be omitted entirely when auth is off, so the Worker still runs
// against a database that predates the group_id column (password mode).
function insertRow(env, table, fields) {
  const cols = Object.keys(fields).filter(k => fields[k] !== undefined);
  const sql  = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return env.DB.prepare(sql).bind(...cols.map(k => fields[k])).run();
}

/* Resolve the authenticated principal: upsert the user, ensure they belong to
   at least one group (provisioning a personal one on first login), and choose
   the active group — the X-Group-Id header when the caller is a member of it,
   otherwise their oldest membership. */
async function resolvePrincipal(request, env, claims) {
  const sub = claims.sub;
  // `sub` is the SOLE identity key. We never link accounts by email: doing so
  // would let an unverified or second identity that presents a matching email
  // adopt another user's row and inherit their groups. Email is only trusted
  // (and stored) when the provider marks it verified, and is purely cosmetic.
  const verified = claims.email_verified === true;
  const email    = verified && typeof claims.email === 'string' ? claims.email : null;
  const name     = claims.name || claims.nickname || email || 'Player';

  let user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(sub).first();
  if (!user) {
    // OR IGNORE: if two first-time requests for the same sub race, the second
    // no-ops on the PK instead of throwing; we re-read either way.
    await env.DB.prepare('INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)')
      .bind(sub, email, name).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(sub).first();
  }
  const userId = user.id;

  let { results: memberships } = await env.DB.prepare(
    'SELECT group_id, role FROM group_members WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(userId).all();

  if (!memberships.length) {
    const gid = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO groups (id, name) VALUES (?, ?)')
      .bind(gid, `${name}'s table`).run();
    await env.DB.prepare(
      'INSERT INTO group_members (id, group_id, user_id, role) VALUES (?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), gid, userId, 'owner').run();
    memberships = [{ group_id: gid, role: 'owner' }];
  }

  const requested = request.headers.get('X-Group-Id');
  const active = (requested && memberships.find(m => m.group_id === requested)) || memberships[0];
  return { userId, email: user.email, name: user.name, groupId: active.group_id, role: active.role };
}

// Look up a single row's owning group_id via `sql` (one bind param: the id).
// Returns true when the caller may touch it: always true when auth is off,
// otherwise the row must exist and belong to the caller's group.
async function ownsRow(env, gid, sql, id) {
  if (!gid) return true;
  const row = await env.DB.prepare(sql).bind(id).first();
  return Boolean(row) && row.group_id === gid;
}

const SQL_SESSION_GROUP = 'SELECT group_id FROM sessions WHERE id = ?';
const SQL_PLAYER_GROUP  =
  'SELECT s.group_id AS group_id FROM session_players sp JOIN sessions s ON s.id = sp.session_id WHERE sp.id = ?';
const SQL_BUYIN_GROUP   =
  `SELECT s.group_id AS group_id FROM buyins b
   JOIN session_players sp ON sp.id = b.session_player_id
   JOIN sessions s ON s.id = sp.session_id WHERE b.id = ?`;
const SQL_VISIT_GROUP   = 'SELECT group_id FROM casino_visits WHERE id = ?';

export default {
  async fetch(request, env) {
    const { pathname: path } = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Legacy password lock — runs before the auth gate so it stays reachable.
    // Only meaningful when Auth0 is NOT configured; ignored by the Auth0 client.
    if (path === '/api/auth' && method === 'POST') {
      try {
        const { password } = await request.json();
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

    // ── Auth gate ──────────────────────────────────────────────────
    // With Auth0 configured, every remaining route requires a valid token and
    // is scoped to ctx.groupId. Without it, ctx is null and gid stays null,
    // so the group filters below match all rows (original behaviour).
    let ctx = null;
    if (authEnabled(env)) {
      let claims;
      try { claims = await authenticate(request, env); }
      catch { return err('Unauthorized', 401); }
      try { ctx = await resolvePrincipal(request, env, claims); }
      catch (e) { return err(e.message); }
    }
    const gid = ctx?.groupId ?? null;

    try {

      /* ── GET /api/me ───────────────────────────────────────────
         The signed-in user + their groups + active group           */
      if (path === '/api/me' && method === 'GET') {
        if (!ctx) return err('Authentication is not enabled', 404);
        const { results: groups } = await env.DB.prepare(
          `SELECT g.id, g.name, gm.role
           FROM   group_members gm
           JOIN   groups g ON g.id = gm.group_id
           WHERE  gm.user_id = ?
           ORDER  BY gm.created_at ASC`
        ).bind(ctx.userId).all();
        return ok({
          id:     ctx.userId,
          email:  ctx.email,
          name:   ctx.name,
          group:  groups.find(g => g.id === gid) ?? null,
          groups,
        });
      }

      /* ── POST /api/invites ─────────────────────────────────────
         Create an invite code for the caller's active group         */
      if (path === '/api/invites' && method === 'POST') {
        if (!ctx) return err('Authentication is not enabled', 404);
        if (!isGroupAdmin(ctx.role))
          return err('Only group owners or admins can invite', 403);
        const body = await request.json().catch(() => ({}));
        const role = INVITE_ROLES.includes(body.role) ? body.role : 'member';
        const id   = crypto.randomUUID();
        const code = crypto.randomUUID().replace(/-/g, '');
        await env.DB.prepare(
          'INSERT INTO invites (id, group_id, code, role, invited_email, created_by) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, gid, code, role, isStr(body.email) ? body.email : null, ctx.userId).run();
        return ok({ code, role, group_id: gid });
      }

      /* ── POST /api/invites/:code/accept ────────────────────────
         Join the invite's group as the signed-in user              */
      const inviteAccept = path.match(/^\/api\/invites\/([^/]+)\/accept$/);
      if (inviteAccept && method === 'POST') {
        if (!ctx) return err('Authentication is not enabled', 404);
        const invite = await env.DB.prepare('SELECT * FROM invites WHERE code = ?')
          .bind(inviteAccept[1]).first();
        if (!invite)             return err('Invite not found', 404);
        if (invite.accepted_at)  return err('Invite already used', 409);
        if (invite.expires_at && Date.parse(invite.expires_at) < Date.now())
          return err('Invite expired', 410);

        const already = await env.DB.prepare(
          'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'
        ).bind(invite.group_id, ctx.userId).first();
        if (!already) {
          await env.DB.prepare(
            'INSERT INTO group_members (id, group_id, user_id, role) VALUES (?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), invite.group_id, ctx.userId, invite.role).run();
        }
        await env.DB.prepare(
          "UPDATE invites SET accepted_by = ?, accepted_at = datetime('now') WHERE id = ?"
        ).bind(ctx.userId, invite.id).run();

        const group = await env.DB.prepare('SELECT id, name FROM groups WHERE id = ?')
          .bind(invite.group_id).first();
        return ok({ group, role: invite.role });
      }

      /* ── GET /api/sessions ─────────────────────────────────────
         All sessions with nested session_players + buyins          */
      if (path === '/api/sessions' && method === 'GET') {
        const gf = groupFilter(gid);
        const { results: sessions } = await env.DB.prepare(
          `SELECT * FROM sessions WHERE ${gf.clause} ORDER BY created_at DESC`
        ).bind(...gf.args).all();

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
        await insertRow(env, 'sessions', {
          id, name, status: 'active', group_id: gid ?? undefined, created_at: created_at || undefined,
        });
        return ok(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first());
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);

      /* ── PATCH /api/sessions/:id ───────────────────────────────
         Update name or status                                      */
      if (sessionMatch && method === 'PATCH') {
        const id   = sessionMatch[1];
        if (!(await ownsRow(env, gid, SQL_SESSION_GROUP, id))) return err('Not found', 404);
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
        if (!(await ownsRow(env, gid, SQL_SESSION_GROUP, id))) return err('Not found', 404);
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
        if (!(await ownsRow(env, gid, SQL_SESSION_GROUP, sessionId))) return err('Not found', 404);
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
        if (!(await ownsRow(env, gid, SQL_SESSION_GROUP, session_id))) return err('Not found', 404);
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
        if (!(await ownsRow(env, gid, SQL_PLAYER_GROUP, id))) return err('Not found', 404);
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
        if (!(await ownsRow(env, gid, SQL_PLAYER_GROUP, id))) return err('Not found', 404);
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
        if (!(await ownsRow(env, gid, SQL_PLAYER_GROUP, session_player_id))) return err('Not found', 404);
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
        if (!(await ownsRow(env, gid, SQL_BUYIN_GROUP, id))) return err('Not found', 404);
        const { amount } = await request.json();
        if (!isPos(amount)) return err('Buy-in amount must be a positive number', 400);
        await env.DB.prepare('UPDATE buyins SET amount = ? WHERE id = ?').bind(amount, id).run();
        return ok({ success: true });
      }

      /* ── DELETE /api/buyins/:id ────────────────────────────────
         Remove a buy-in entry                                      */
      if (buyinMatch && method === 'DELETE') {
        const id = buyinMatch[1];
        if (!(await ownsRow(env, gid, SQL_BUYIN_GROUP, id))) return err('Not found', 404);
        await env.DB.prepare('DELETE FROM buyins WHERE id = ?').bind(id).run();
        return ok({ success: true });
      }

      /* ── GET /api/stats ────────────────────────────────────────
         Settled session stats for leaderboard, records, dashboard  */
      if (path === '/api/stats' && method === 'GET') {
        const gf = groupFilter(gid, 's.group_id');
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
            AND  ${gf.clause}
          ORDER  BY s.created_at DESC
        `).bind(...gf.args).all();

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
        const gf = groupFilter(gid, 's.group_id');

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
            AND  ${gf.clause}
          ORDER  BY s.created_at DESC
        `).bind(playerName, ...gf.args).all();

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
        const gf = groupFilter(gid);
        const { results } = await env.DB.prepare(
          `SELECT * FROM casino_visits WHERE ${gf.clause} ORDER BY created_at DESC`
        ).bind(...gf.args).all();
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
        await insertRow(env, 'casino_visits', {
          id, casino_name, buy_in,
          cash_out:   cash_out ?? null,
          games:      games ?? '',
          notes:      notes ?? null,
          group_id:   gid ?? undefined,
          created_at: created_at || undefined,
        });
        return ok(await env.DB.prepare('SELECT * FROM casino_visits WHERE id = ?').bind(id).first());
      }

      const casinoVisitMatch = path.match(/^\/api\/casino\/visits\/([^/]+)$/);

      /* ── PATCH /api/casino/visits/:id ──────────────────────────
         Update a casino visit (settle cash_out, add notes)         */
      if (casinoVisitMatch && method === 'PATCH') {
        const id   = casinoVisitMatch[1];
        if (!(await ownsRow(env, gid, SQL_VISIT_GROUP, id))) return err('Not found', 404);
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
        if (!(await ownsRow(env, gid, SQL_VISIT_GROUP, id))) return err('Not found', 404);
        await env.DB.prepare('DELETE FROM casino_visits WHERE id = ?').bind(id).run();
        return ok({ success: true });
      }

      /* ── GET /api/casino/stats ─────────────────────────────────
         Aggregated stats for the casino dashboard                  */
      if (path === '/api/casino/stats' && method === 'GET') {
        const gf = groupFilter(gid);
        const { results } = await env.DB.prepare(
          `SELECT * FROM casino_visits WHERE cash_out IS NOT NULL AND ${gf.clause} ORDER BY created_at ASC`
        ).bind(...gf.args).all();
        return ok(results);
      }

      return err('Not found', 404);

    } catch (e) {
      return err(e.message);
    }
  },
};
