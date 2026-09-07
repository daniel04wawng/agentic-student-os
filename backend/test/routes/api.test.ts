import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { freshDb, resetDb } from '../db/helpers.js';

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
  app = buildServer(loadConfig({ LOG_LEVEL: 'fatal' }), { db });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe('DB-backed routes', () => {
  it('registers a device (and 400s on bad input)', async () => {
    const ok = await app.inject({ method: 'POST', url: '/devices', payload: { token: 'tok-1' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBeTruthy();

    const bad = await app.inject({ method: 'POST', url: '/devices', payload: {} });
    expect(bad.statusCode).toBe(400);
  });

  it('serves /deadlines, /today, /review', async () => {
    await db.query(
      `INSERT INTO courses (name, source, source_id, metadata)
       VALUES ('CS','canvas','c1', jsonb_build_object('time_zone','America/New_York'))`,
    );
    await db.query(
      `INSERT INTO assignments (course_id, title, due_at, source, source_id)
       SELECT id, 'HW1', now() + interval '1 day', 'canvas', 'a1' FROM courses LIMIT 1`,
    );

    const deadlines = await app.inject({ method: 'GET', url: '/deadlines?tz=America/New_York' });
    expect(deadlines.statusCode).toBe(200);
    expect(Array.isArray(deadlines.json())).toBe(true);
    expect(deadlines.json().length).toBe(1);

    expect((await app.inject({ method: 'GET', url: '/today?tz=UTC' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/review' })).statusCode).toBe(200);
  });

  it('dismisses a notification (400 on non-uuid)', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO notifications (kind, title) VALUES ('info','x') RETURNING id`,
    );
    const ok = await app.inject({ method: 'POST', url: `/notifications/${rows[0]!.id}/dismiss` });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({ method: 'POST', url: '/notifications/not-a-uuid/dismiss' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('routes are not mounted without a db', () => {
  it('returns 404 for /deadlines when no db is injected', async () => {
    const noDb = buildServer(loadConfig({ LOG_LEVEL: 'fatal' }));
    await noDb.ready();
    const res = await noDb.inject({ method: 'GET', url: '/deadlines' });
    expect(res.statusCode).toBe(404);
    await noDb.close();
  });
});
