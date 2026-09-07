import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { InMemoryStorageProvider } from '../../src/storage/provider.js';
import { FakeTranscriptionProvider } from '../../src/transcription/provider.js';
import {
  TRANSCRIPTION_COMPLETED,
  requestTranscription,
  runTranscription,
} from '../../src/transcription/service.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let storage: InMemoryStorageProvider;
let bus: EventBus;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  storage = new InMemoryStorageProvider();
  bus = new EventBus(db);
});

async function storedRecording(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO recordings (client_id, status, storage_key, content_type)
     VALUES ('c1','stored','recordings/k','audio/m4a') RETURNING id`,
  );
  await storage.put('recordings/k', Buffer.from('audio'), 'audio/m4a');
  return rows[0]!.id;
}

async function transcriptStatus(id: string): Promise<{ status: string; attempts: number }> {
  const { rows } = await db.query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM transcripts WHERE id=$1`,
    [id],
  );
  return rows[0]!;
}
async function completedEvents(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE type=$1`,
    [TRANSCRIPTION_COMPLETED],
  );
  return rows[0]!.n;
}

describe('requestTranscription', () => {
  it('is idempotent per recording', async () => {
    const rec = await storedRecording();
    const a = await requestTranscription(db, rec);
    const b = await requestTranscription(db, rec);
    expect(a.id).toBe(b.id);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM transcripts`);
    expect(rows[0]!.n).toBe(1);
  });
});

describe('runTranscription', () => {
  it('stores diarized words + timestamps and emits transcription.completed', async () => {
    const rec = await storedRecording();
    const t = await requestTranscription(db, rec);
    await runTranscription(db, storage, new FakeTranscriptionProvider(), bus, t.id);

    const { rows } = await db.query<{ text: string; words: unknown[]; status: string }>(
      `SELECT text, words, status FROM transcripts WHERE id=$1`,
      [t.id],
    );
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.text).toBe('hello world');
    const words = rows[0]!.words as { word: string; start: number; speaker: number }[];
    expect(words).toHaveLength(2);
    expect(words[0]).toMatchObject({ word: 'hello', start: 0, speaker: 0 });
    expect(await completedEvents()).toBe(1);
  });

  it('keeps the audio when the provider fails (no completion event)', async () => {
    const rec = await storedRecording();
    const t = await requestTranscription(db, rec);
    await expect(
      runTranscription(db, storage, new FakeTranscriptionProvider({ fail: true }), bus, t.id),
    ).rejects.toThrow();

    expect(await transcriptStatus(t.id)).toMatchObject({ status: 'failed', attempts: 1 });
    // Audio blob untouched, recording still stored.
    expect(await storage.exists('recordings/k')).toBe(true);
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM recordings WHERE id=$1`,
      [rec],
    );
    expect(rows[0]!.status).toBe('stored');
    expect(await completedEvents()).toBe(0);
  });

  it('is retryable after a failure', async () => {
    const rec = await storedRecording();
    const t = await requestTranscription(db, rec);
    await expect(
      runTranscription(db, storage, new FakeTranscriptionProvider({ fail: true }), bus, t.id),
    ).rejects.toThrow();
    await runTranscription(db, storage, new FakeTranscriptionProvider(), bus, t.id);
    expect((await transcriptStatus(t.id)).status).toBe('completed');
    expect(await completedEvents()).toBe(1);
  });

  it('throws when the recording audio is not stored', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO recordings (client_id, status) VALUES ('c2','pending') RETURNING id`,
    );
    const t = await requestTranscription(db, rows[0]!.id);
    await expect(
      runTranscription(db, storage, new FakeTranscriptionProvider(), bus, t.id),
    ).rejects.toThrow(/not stored/);
  });
});
