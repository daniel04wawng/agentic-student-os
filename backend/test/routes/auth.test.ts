import { createHmac } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { InMemoryStorageProvider } from '../../src/storage/provider.js';
import { freshDb, resetDb } from '../db/helpers.js';

const SECRET = 'test-jwt-secret';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}
function sign(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

let db: PGlite;
let app: FastifyInstance;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  app = buildServer(loadConfig({ LOG_LEVEL: 'fatal' }), {
    db,
    storage: new InMemoryStorageProvider(),
    supabaseJwtSecret: SECRET,
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe('auth hook (when a Supabase JWT secret is configured)', () => {
  it('leaves /health open', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('401s a protected route with no bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('401s an invalid bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sessions',
      headers: { authorization: 'Bearer not.a.valid.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows a valid bearer token', async () => {
    const token = sign({ sub: 'user-abc', exp: Math.floor(Date.now() / 1000) + 3600 });
    const res = await app.inject({
      method: 'GET',
      url: '/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('auth hook (no secret configured = legacy open mode)', () => {
  it('leaves protected routes open', async () => {
    const open = buildServer(loadConfig({ LOG_LEVEL: 'fatal' }), { db, storage: new InMemoryStorageProvider() });
    await open.ready();
    const res = await open.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    await open.close();
  });
});
