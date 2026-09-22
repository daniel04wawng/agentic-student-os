import { createSign, generateKeyPairSync } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issueTokens } from '../../src/auth/tokens.js';
import { loadConfig } from '../../src/config.js';
import type { SqlClient } from '../../src/db/client.js';
import { registerAuthRoutes } from '../../src/routes/auth.js';
import { buildServer } from '../../src/server.js';
import { InMemoryStorageProvider } from '../../src/storage/provider.js';
import { freshDb, resetDb } from '../db/helpers.js';

const SECRET = 'test-session-secret';
const CLIENT_ID = 'com.danielwang.studentos';

// A test key pair standing in for Apple's signing key.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const jwksFetch: typeof fetch = (async () =>
  ({ ok: true, json: async () => ({ keys: [jwk] }) }) as unknown as Response) as unknown as typeof fetch;

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}
function appleToken(): string {
  const payload = {
    iss: 'https://appleid.apple.com',
    aud: CLIENT_ID,
    sub: 'apple-abc',
    email: 'friend@nyu.edu',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

describe('auth hook (session bearer required when a secret is set)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = buildServer(loadConfig({ LOG_LEVEL: 'fatal' }), {
      db,
      storage: new InMemoryStorageProvider(),
      authJwtSecret: SECRET,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('leaves /health open', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
  it('401s a protected route with no bearer', async () => {
    expect((await app.inject({ method: 'GET', url: '/sessions' })).statusCode).toBe(401);
  });
  it('401s an invalid bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions', headers: { authorization: 'Bearer bad' } });
    expect(res.statusCode).toBe(401);
  });
  it('allows a valid session access token', async () => {
    const { accessToken } = issueTokens('user-xyz', SECRET);
    const res = await app.inject({ method: 'GET', url: '/sessions', headers: { authorization: `Bearer ${accessToken}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe('sign-in routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    // Bare app so we can inject the fake Apple JWKS fetch.
    app = Fastify({ logger: false });
    registerAuthRoutes(app, db as unknown as SqlClient, { jwtSecret: SECRET, appleClientId: CLIENT_ID, fetchImpl: jwksFetch });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('signs in with Apple, creates the user, and returns session tokens', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/apple', payload: { id_token: appleToken() } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.user_id).toBeTruthy();
    const users = await db.query<{ email: string }>(`SELECT email FROM users WHERE apple_sub='apple-abc'`);
    expect(users.rows[0]!.email).toBe('friend@nyu.edu');

    // Same Apple user signs in again -> same user id (idempotent).
    const again = await app.inject({ method: 'POST', url: '/auth/apple', payload: { id_token: appleToken() } });
    expect(again.json().user_id).toBe(body.user_id);

    // Refresh swaps for a fresh pair.
    const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: body.refresh_token } });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().user_id).toBe(body.user_id);
  });

  it('rejects a bad Apple token', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/apple', payload: { id_token: 'not.a.token' } });
    expect(res.statusCode).toBe(401);
  });
});
