import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { InMemoryStorageProvider } from '../../src/storage/provider.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let storage: InMemoryStorageProvider;
let app: FastifyInstance;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  storage = new InMemoryStorageProvider();
  app = buildServer(loadConfig({ LOG_LEVEL: 'fatal' }), { db, storage });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe('recording routes', () => {
  it('registers a recording idempotently and returns an upload path', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/recordings',
      payload: { client_id: 'rec-1', content_type: 'audio/m4a' },
    });
    expect(first.statusCode).toBe(200);
    const id = first.json().id;
    expect(first.json().upload_path).toBe(`/recordings/${id}/audio`);

    const again = await app.inject({
      method: 'POST',
      url: '/recordings',
      payload: { client_id: 'rec-1' },
    });
    expect(again.json().id).toBe(id); // idempotent
  });

  it('accepts an audio upload and stores it', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/recordings',
      payload: { client_id: 'rec-1' },
    });
    const id = reg.json().id;
    const audio = Buffer.from('binary-audio-content');

    const put = await app.inject({
      method: 'PUT',
      url: `/recordings/${id}/audio`,
      payload: audio,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().status).toBe('stored');
    expect(await storage.exists(`recordings/${id}`)).toBe(true);
  });

  it('400s an empty body and 404s an unknown recording', async () => {
    const reg = await app.inject({ method: 'POST', url: '/recordings', payload: { client_id: 'r' } });
    const id = reg.json().id;

    const empty = await app.inject({
      method: 'PUT',
      url: `/recordings/${id}/audio`,
      payload: Buffer.alloc(0),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(empty.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PUT',
      url: `/recordings/00000000-0000-0000-0000-000000000000/audio`,
      payload: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
