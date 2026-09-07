import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getRecording,
  registerRecording,
  storeAudio,
} from '../../src/recordings/service.js';
import { InMemoryStorageProvider, type StorageProvider } from '../../src/storage/provider.js';
import { freshDb, resetDb } from '../db/helpers.js';

class FailingStorage implements StorageProvider {
  async put(): Promise<void> {
    throw new Error('storage down');
  }
  async get(): Promise<Buffer> {
    throw new Error('n/a');
  }
  async exists(): Promise<boolean> {
    return false;
  }
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

async function statusOf(id: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM recordings WHERE id=$1`,
    [id],
  );
  return rows[0]!.status;
}

describe('registerRecording', () => {
  it('is idempotent on client_id', async () => {
    const a = await registerRecording(db, { clientId: 'rec-1' });
    const b = await registerRecording(db, { clientId: 'rec-1' });
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('pending');
  });
});

describe('storeAudio', () => {
  it('stores the bytes and marks the recording stored', async () => {
    const storage = new InMemoryStorageProvider();
    const rec = await registerRecording(db, { clientId: 'rec-1' });
    const bytes = Buffer.from('fake-audio-bytes');
    const res = await storeAudio(db, storage, rec.id, bytes);

    expect(res.size).toBe(bytes.length);
    expect(await statusOf(rec.id)).toBe('stored');
    expect(await storage.exists(res.key)).toBe(true);
    const row = await getRecording(db, rec.id);
    expect(row?.storage_key).toBe(res.key);
  });

  it('marks failed but KEEPS the recording when storage fails', async () => {
    const rec = await registerRecording(db, { clientId: 'rec-2' });
    await expect(storeAudio(db, new FailingStorage(), rec.id, Buffer.from('x'))).rejects.toThrow(
      'storage down',
    );
    expect(await statusOf(rec.id)).toBe('failed');
    // Recording row still present; device retains its local copy and can retry.
    expect(await getRecording(db, rec.id)).not.toBeNull();
  });

  it('is resumable: a retry after failure succeeds and clears the error', async () => {
    const rec = await registerRecording(db, { clientId: 'rec-3' });
    await expect(storeAudio(db, new FailingStorage(), rec.id, Buffer.from('x'))).rejects.toThrow();
    const storage = new InMemoryStorageProvider();
    await storeAudio(db, storage, rec.id, Buffer.from('good'));
    expect(await statusOf(rec.id)).toBe('stored');
    const { rows } = await db.query<{ err: string | null }>(
      `SELECT last_error AS err FROM recordings WHERE id=$1`,
      [rec.id],
    );
    expect(rows[0]!.err).toBeNull();
  });
});
