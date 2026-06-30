import { describe, it, expect } from 'vitest';
import { verifyJwt } from './src/auth.js';

/* Exercises the RS256 verification path end-to-end with a locally generated
   key pair (no network, no real Auth0 tenant). A getPublicKey resolver feeds
   the matching public key in; mismatch/expiry/claim checks are asserted. */

const enc = new TextEncoder();

const b64url = input => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const seg = obj => b64url(enc.encode(JSON.stringify(obj)));

const ISSUER = 'https://example.auth0.com/';
const AUDIENCE = 'https://api.poker-tracker';
const NOW = 1_700_000_000;

async function makeKeyPair(kid = 'test-key-1') {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  jwk.kid = kid;
  const getPublicKey = async () => crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  return { kp, jwk, getPublicKey };
}

async function signToken(kp, { header = {}, payload }) {
  const h = seg({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1', ...header });
  const p = seg(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

const goodClaims = (over = {}) => ({
  iss: ISSUER, aud: AUDIENCE, sub: 'auth0|abc', email: 'a@b.com',
  exp: NOW + 3600, iat: NOW, ...over,
});
const verify = (token, getPublicKey, over = {}) =>
  verifyJwt(token, { issuer: ISSUER, audience: AUDIENCE, getPublicKey, now: NOW, ...over });

describe('verifyJwt', () => {
  it('accepts a valid token and returns its claims', async () => {
    const { kp, getPublicKey } = await makeKeyPair();
    const token = await signToken(kp, { payload: goodClaims() });
    const claims = await verify(token, getPublicKey);
    expect(claims.sub).toBe('auth0|abc');
    expect(claims.email).toBe('a@b.com');
  });

  it('accepts an audience array that contains the audience', async () => {
    const { kp, getPublicKey } = await makeKeyPair();
    const token = await signToken(kp, { payload: goodClaims({ aud: ['other', AUDIENCE] }) });
    await expect(verify(token, getPublicKey)).resolves.toBeTruthy();
  });

  it('rejects a tampered payload (signature mismatch)', async () => {
    const { kp, getPublicKey } = await makeKeyPair();
    const token = await signToken(kp, { payload: goodClaims() });
    const [h, , s] = token.split('.');
    const forged = `${h}.${seg(goodClaims({ sub: 'auth0|attacker' }))}.${s}`;
    await expect(verify(forged, getPublicKey)).rejects.toThrow('Bad signature');
  });

  it('rejects a token signed by a different key', async () => {
    const signer = await makeKeyPair();
    const other = await makeKeyPair();
    const token = await signToken(signer.kp, { payload: goodClaims() });
    await expect(verify(token, other.getPublicKey)).rejects.toThrow('Bad signature');
  });

  it('rejects the wrong audience', async () => {
    const { kp, getPublicKey } = await makeKeyPair();
    const token = await signToken(kp, { payload: goodClaims({ aud: 'https://api.someone-else' }) });
    await expect(verify(token, getPublicKey)).rejects.toThrow('Bad audience');
  });

  it('rejects the wrong issuer', async () => {
    const { kp, getPublicKey } = await makeKeyPair();
    const token = await signToken(kp, { payload: goodClaims({ iss: 'https://evil.example/' }) });
    await expect(verify(token, getPublicKey)).rejects.toThrow('Bad issuer');
  });

  it('rejects an expired token (beyond clock skew)', async () => {
    const { kp, getPublicKey } = await makeKeyPair();
    const token = await signToken(kp, { payload: goodClaims({ exp: NOW - 120 }) });
    await expect(verify(token, getPublicKey)).rejects.toThrow('Token expired');
  });

  it('rejects alg:none and HS256 (no alg-confusion downgrade)', async () => {
    const { kp, getPublicKey } = await makeKeyPair();
    const none = await signToken(kp, { header: { alg: 'none' }, payload: goodClaims() });
    const hs = await signToken(kp, { header: { alg: 'HS256' }, payload: goodClaims() });
    await expect(verify(none, getPublicKey)).rejects.toThrow('Unsupported alg');
    await expect(verify(hs, getPublicKey)).rejects.toThrow('Unsupported alg');
  });

  it('rejects a malformed token', async () => {
    const { getPublicKey } = await makeKeyPair();
    await expect(verify('not-a-jwt', getPublicKey)).rejects.toThrow('Malformed token');
  });
});
