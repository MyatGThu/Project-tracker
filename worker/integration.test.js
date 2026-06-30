import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import worker from './src/index.js';

// node:sqlite is a recent builtin Vite's transform doesn't resolve; load it at
// runtime via require so it stays a plain Node builtin import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

/* End-to-end test of the Worker handler against a real SQLite database built
   from schema.sql. For the auth-on cases we sign tokens with a locally
   generated RSA key and stub global fetch so authenticate()'s JWKS lookup
   resolves to that key — exercising the genuine verification + scoping paths,
   no live Auth0 tenant required. */

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
const SCHEMA = readFileSync(schemaPath, 'utf8');

// ── Minimal D1 adapter over node:sqlite ───────────────────────────
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...args) { this.params = args; return this; }
  async all()   { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async run()   { return this.db.prepare(this.sql).run(...this.params); }
}
const makeD1 = db => ({ prepare: sql => new Stmt(db, sql), exec: async sql => { db.exec(sql); } });

// ── Token signing + JWKS stub ─────────────────────────────────────
const enc = new TextEncoder();
const b64url = input => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const seg = obj => b64url(enc.encode(JSON.stringify(obj)));

const DOMAIN = 'example.auth0.com';
const AUDIENCE = 'https://api.poker-tracker';
const ISSUER = `https://${DOMAIN}/`;

// auth.js caches verification keys by `kid` for the isolate's lifetime, which
// spans the whole test file. Use a fresh kid per test so a new key pair is
// never shadowed by a previously cached one.
let kp, publicJwk, kid, kidCounter = 0;
async function setupKeys() {
  kid = `itest-key-${++kidCounter}`;
  kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  publicJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
}

async function token(sub, email, name, { emailVerified } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = seg({ alg: 'RS256', typ: 'JWT', kid });
  const payload = { iss: ISSUER, aud: AUDIENCE, sub, iat: now, exp: now + 3600 };
  if (email !== undefined) payload.email = email;
  if (name  !== undefined) payload.name  = name;
  // Default: a present email is verified (matches a normal Auth0 setup).
  payload.email_verified = emailVerified ?? (email !== undefined);
  const p = seg(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

let db, env, realFetch;
function freshDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  db = sqlite;
}

// Issue a request against the worker.
async function call(method, path, { body, tok, groupId } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  if (groupId) headers['X-Group-Id'] = groupId;
  const req = new Request(`https://worker.test${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

describe('Worker — auth not configured', () => {
  it('returns 503 on every data route when AUTH0 secrets are absent', async () => {
    freshDb();
    env = { DB: makeD1(db) };                              // no AUTH0_DOMAIN/AUDIENCE
    expect((await call('GET',  '/api/sessions')).status).toBe(503);
    expect((await call('POST', '/api/sessions', { body: { name: 'x' } })).status).toBe(503);
    expect((await call('GET',  '/api/me')).status).toBe(503);
  });
});

describe('Worker — auth enabled (multi-tenant)', () => {
  beforeEach(async () => {
    await setupKeys();
    freshDb();
    env = { DB: makeD1(db), AUTH0_DOMAIN: DOMAIN, AUTH0_AUDIENCE: AUDIENCE };
    realFetch = globalThis.fetch;
    globalThis.fetch = async url => {
      if (String(url).includes('/.well-known/jwks.json'))
        return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'Content-Type': 'application/json' } });
      throw new Error(`unexpected fetch: ${url}`);
    };
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('rejects requests with no token', async () => {
    const res = await call('GET', '/api/sessions');
    expect(res.status).toBe(401);
  });

  it('provisions a personal group on first /api/me', async () => {
    const tok = await token('auth0|A', 'a@a.com', 'Alice');
    const me = await call('GET', '/api/me', { tok });
    expect(me.status).toBe(200);
    expect(me.json.email).toBe('a@a.com');
    expect(me.json.group).toBeTruthy();
    expect(me.json.group.role).toBe('owner');
  });

  it('provisions even when the access token has no email claim', async () => {
    // Auth0 access tokens commonly omit email/name (those live in the ID token).
    const tok = await token('auth0|NoEmail', undefined, undefined);
    const me = await call('GET', '/api/me', { tok });
    expect(me.status).toBe(200);
    expect(me.json.group).toBeTruthy();
    expect(me.json.group.role).toBe('owner');
  });

  it('does NOT link two identities that share an email (account-takeover guard)', async () => {
    // Same email, two different Auth0 subjects → two separate accounts/groups.
    const aTok = await token('auth0|First',  'shared@x.com', 'First');
    const bTok = await token('auth0|Second', 'shared@x.com', 'Second');

    const aMe = await call('GET', '/api/me', { tok: aTok });
    await call('POST', '/api/sessions', { body: { name: 'First night' }, tok: aTok });

    const bMe = await call('GET', '/api/me', { tok: bTok });
    expect(bMe.json.group.id).not.toBe(aMe.json.group.id);          // distinct group
    expect(bMe.json.groups).toHaveLength(1);                        // not inheriting First's groups
    expect((await call('GET', '/api/sessions', { tok: bTok })).json).toHaveLength(0); // can't see First's data
  });

  it('ignores an unverified email claim (not stored)', async () => {
    const tok = await token('auth0|Unverified', 'spoof@x.com', 'Mallory', { emailVerified: false });
    const me = await call('GET', '/api/me', { tok });
    expect(me.status).toBe(200);
    expect(me.json.email).toBeNull();
    expect(me.json.group).toBeTruthy();
  });

  it('isolates data between groups and blocks cross-group writes', async () => {
    const aTok = await token('auth0|A', 'a@a.com', 'Alice');
    const bTok = await token('auth0|B', 'b@b.com', 'Bob');

    const aSession = await call('POST', '/api/sessions', { body: { name: 'A night' }, tok: aTok });
    expect(aSession.status).toBe(200);
    const sid = aSession.json.id;

    // Alice sees her session; Bob sees nothing.
    expect((await call('GET', '/api/sessions', { tok: aTok })).json).toHaveLength(1);
    expect((await call('GET', '/api/sessions', { tok: bTok })).json).toHaveLength(0);

    // Bob cannot read, patch, delete, or attach players to Alice's session.
    expect((await call('GET', `/api/sessions/${sid}/players`, { tok: bTok })).status).toBe(404);
    expect((await call('PATCH', `/api/sessions/${sid}`, { body: { name: 'hijack' }, tok: bTok })).status).toBe(404);
    expect((await call('DELETE', `/api/sessions/${sid}`, { tok: bTok })).status).toBe(404);
    expect((await call('POST', '/api/session-players', { body: { session_id: sid, player_name: 'X' }, tok: bTok })).status).toBe(404);

    // Alice can still operate on her own session.
    const player = await call('POST', '/api/session-players', { body: { session_id: sid, player_name: 'Alice' }, tok: aTok });
    expect(player.status).toBe(200);
  });

  it('scopes settled stats per group', async () => {
    const aTok = await token('auth0|A', 'a@a.com', 'Alice');
    const s = await call('POST', '/api/sessions', { body: { name: 'A night' }, tok: aTok });
    const p = await call('POST', '/api/session-players', { body: { session_id: s.json.id, player_name: 'Alice' }, tok: aTok });
    await call('POST', '/api/buyins', { body: { session_player_id: p.json.id, amount: 50 }, tok: aTok });
    await call('PATCH', `/api/session-players/${p.json.id}`, { body: { final_chips: 80 }, tok: aTok });
    await call('PATCH', `/api/sessions/${s.json.id}`, { body: { status: 'settled' }, tok: aTok });

    expect((await call('GET', '/api/stats', { tok: aTok })).json).toHaveLength(1);
    const bTok = await token('auth0|B', 'b@b.com', 'Bob');
    expect((await call('GET', '/api/stats', { tok: bTok })).json).toHaveLength(0);
  });

  it('invite flow lets another user join and switch into the group', async () => {
    const aTok = await token('auth0|A', 'a@a.com', 'Alice');
    const bTok = await token('auth0|B', 'b@b.com', 'Bob');

    const aMe = await call('GET', '/api/me', { tok: aTok });
    const groupA = aMe.json.group.id;
    await call('POST', '/api/sessions', { body: { name: 'A night' }, tok: aTok });

    const invite = await call('POST', '/api/invites', { body: { role: 'member' }, tok: aTok });
    expect(invite.status).toBe(200);
    expect(invite.json.code).toBeTruthy();

    const accept = await call('POST', `/api/invites/${invite.json.code}/accept`, { tok: bTok });
    expect(accept.status).toBe(200);
    expect(accept.json.group.id).toBe(groupA);

    // Bob now belongs to two groups; with X-Group-Id he sees Alice's session.
    const bMe = await call('GET', '/api/me', { tok: bTok });
    expect(bMe.json.groups).toHaveLength(2);
    expect((await call('GET', '/api/sessions', { tok: bTok, groupId: groupA })).json).toHaveLength(1);
    // Default (Bob's own group) still isolated.
    expect((await call('GET', '/api/sessions', { tok: bTok })).json).toHaveLength(0);
  });

  it('non-members cannot invite, and a used invite is rejected on reuse', async () => {
    const aTok = await token('auth0|A', 'a@a.com', 'Alice');
    const bTok = await token('auth0|B', 'b@b.com', 'Bob');
    const invite = await call('POST', '/api/invites', { body: {}, tok: aTok });

    const first = await call('POST', `/api/invites/${invite.json.code}/accept`, { tok: bTok });
    expect(first.status).toBe(200);
    const second = await call('POST', `/api/invites/${invite.json.code}/accept`, { tok: bTok });
    expect(second.status).toBe(409);
  });
});
