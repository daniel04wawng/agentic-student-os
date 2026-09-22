import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyAppleIdToken } from '../../src/auth/apple.js';

const CLIENT_ID = 'com.danielwang.studentos';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'test-kid', alg: 'RS256', use: 'sig' };

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function signAppleToken(payload: Record<string, unknown>, key = privateKey): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(key).toString('base64url')}`;
}

/** A fetch that serves our test JWKS as Apple's key endpoint would. */
const jwksFetch: typeof fetch = (async () =>
  ({ ok: true, json: async () => ({ keys: [jwk] }) }) as unknown as Response) as unknown as typeof fetch;

const base = {
  iss: 'https://appleid.apple.com',
  aud: CLIENT_ID,
  sub: 'apple-user-999',
  email: 'grad@ivey.ca',
  exp: Math.floor(Date.now() / 1000) + 3600,
};

describe('verifyAppleIdToken', () => {
  it('verifies a well-formed token and returns the apple id + email', async () => {
    const token = signAppleToken(base);
    const id = await verifyAppleIdToken(token, { clientId: CLIENT_ID, fetchImpl: jwksFetch });
    expect(id).toEqual({ appleSub: 'apple-user-999', email: 'grad@ivey.ca' });
  });

  it('rejects a token for a different audience', async () => {
    const token = signAppleToken({ ...base, aud: 'com.someone.else' });
    await expect(verifyAppleIdToken(token, { clientId: CLIENT_ID, fetchImpl: jwksFetch })).rejects.toThrow(/audience/);
  });

  it('rejects an expired token', async () => {
    const token = signAppleToken({ ...base, exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(verifyAppleIdToken(token, { clientId: CLIENT_ID, fetchImpl: jwksFetch })).rejects.toThrow(/expired/);
  });

  it('rejects a token signed by a different key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const token = signAppleToken(base, other);
    await expect(verifyAppleIdToken(token, { clientId: CLIENT_ID, fetchImpl: jwksFetch })).rejects.toThrow(/signature/);
  });
});
