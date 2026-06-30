/* ─────────────────────────────────────────────────────────────
   Auth0 (OIDC) token verification for the Worker — TODO Phase 2.

   Verifies an RS256 access token against the tenant's JWKS, then checks
   issuer / audience / expiry. No third-party dependencies: signature
   verification uses the runtime's WebCrypto (works in Workers and in Node
   18+ under Vitest, so the crypto path is unit-tested).

   Auth is OPT-IN per deployment: it only switches on when the AUTH0_DOMAIN
   and AUTH0_AUDIENCE secrets are set (see authEnabled). Until then the API
   keeps its original unauthenticated behaviour.
   ───────────────────────────────────────────────────────────── */

// base64url → bytes (atob handles standard base64; we normalise first).
function b64urlToBytes(seg) {
  let s = seg.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const decodeJsonSegment = seg => JSON.parse(new TextDecoder().decode(b64urlToBytes(seg)));

// Warm-isolate cache of imported verification keys, keyed by JWK `kid`.
// Auth0 rotates by minting a new kid, so caching by kid never serves a stale
// key; an unknown kid simply triggers a fresh JWKS fetch.
const keyCache = new Map();

function importJwk(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

async function fetchKey(kid, jwksUri) {
  if (keyCache.has(kid)) return keyCache.get(kid);
  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error('Unable to fetch JWKS');
  const { keys } = await res.json();
  for (const jwk of keys || []) {
    if (jwk.kty === 'RSA' && jwk.kid) keyCache.set(jwk.kid, await importJwk(jwk));
  }
  if (!keyCache.has(kid)) throw new Error('Signing key not found');
  return keyCache.get(kid);
}

/* Verify a compact JWS. `getPublicKey(kid) → CryptoKey` is injected so tests
   can supply a local key without a network JWKS. `now` (epoch seconds) is
   overridable for deterministic expiry tests. Throws on any failure. */
export async function verifyJwt(token, { issuer, audience, getPublicKey, now }) {
  if (typeof token !== 'string' || token.split('.').length !== 3)
    throw new Error('Malformed token');

  const [h, p, s] = token.split('.');
  const header = decodeJsonSegment(h);
  if (header.alg !== 'RS256') throw new Error('Unsupported alg');   // block alg:none + HS* confusion
  if (!header.kid) throw new Error('Missing kid');

  const key = await getPublicKey(header.kid);
  const data = new TextEncoder().encode(`${h}.${p}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), data);
  if (!valid) throw new Error('Bad signature');

  const claims = decodeJsonSegment(p);
  const t = now ?? Math.floor(Date.now() / 1000);
  const skew = 60; // tolerate up to a minute of clock drift

  if (claims.iss !== issuer) throw new Error('Bad issuer');
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(audience)) throw new Error('Bad audience');
  if (typeof claims.exp !== 'number' || t > claims.exp + skew) throw new Error('Token expired');
  if (typeof claims.nbf === 'number' && t + skew < claims.nbf) throw new Error('Token not yet valid');

  return claims;
}

/* True when this deployment is configured for Auth0. */
export const authEnabled = env => Boolean(env.AUTH0_DOMAIN && env.AUTH0_AUDIENCE);

function auth0Config(env) {
  const domain = env.AUTH0_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return {
    issuer:   `https://${domain}/`,
    audience: env.AUTH0_AUDIENCE,
    jwksUri:  `https://${domain}/.well-known/jwks.json`,
  };
}

/* Verify the Bearer token on a request and return its claims, or throw. */
export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error('Missing bearer token');
  const { issuer, audience, jwksUri } = auth0Config(env);
  return verifyJwt(m[1], {
    issuer,
    audience,
    getPublicKey: kid => fetchKey(kid, jwksUri),
  });
}
