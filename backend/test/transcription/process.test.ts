import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { InMemoryStorageProvider } from '../../src/storage/provider.js';
import { FakeTranscriptionProvider } from '../../src/transcription/provider.js';
import {
  TRANSCRIPT_PROCESSED,
  extractStructure,
  processTranscript,
  registerTranscriptProcessor,
  resolveSession,
} from '../../src/transcription/process.js';
import { requestTranscription, runTranscription } from '../../src/transcription/service.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let bus: EventBus;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  bus = new EventBus(db);
});

async function seedCourse(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('CS','canvas','c1') RETURNING id`,
  );
  return rows[0]!.id;
}
async function seedSession(courseId: string, starts: string, ends: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sessions (course_id, kind, starts_at, ends_at) VALUES ($1,'lecture',$2,$3) RETURNING id`,
    [courseId, starts, ends],
  );
  return rows[0]!.id;
}
async function seedTranscript(capturedAt: string): Promise<{ recordingId: string; transcriptId: string }> {
  const rec = await db.query<{ id: string }>(
    `INSERT INTO recordings (client_id, status, storage_key, content_type, captured_at)
     VALUES ('c1','stored','recordings/k','audio/m4a',$1) RETURNING id`,
    [capturedAt],
  );
  const recordingId = rec.rows[0]!.id;
  const t = await requestTranscription(db, recordingId);
  await db.query(
    `UPDATE transcripts SET status='completed', duration_s=1.1,
       words=$2::jsonb, utterances=$3::jsonb WHERE id=$1`,
    [
      t.id,
      JSON.stringify([
        { word: 'a', start: 0, end: 0.3, speaker: 0 },
        { word: 'b', start: 0.4, end: 0.7, speaker: 1 },
      ]),
      JSON.stringify([{ speaker: 0, start: 0, end: 0.3, text: 'a' }]),
    ],
  );
  return { recordingId, transcriptId: t.id };
}

describe('extractStructure', () => {
  it('counts words, utterances, and distinct speakers', () => {
    const e = extractStructure(
      [
        { word: 'a', start: 0, end: 1, speaker: 0 },
        { word: 'b', start: 1, end: 2, speaker: 1 },
        { word: 'c', start: 2, end: 3, speaker: 1 },
      ],
      [{ speaker: 0, start: 0, end: 1, text: 'a' }],
      3,
    );
    expect(e).toMatchObject({ word_count: 3, utterance_count: 1, speaker_count: 2, speakers: [0, 1] });
  });
});

describe('resolveSession', () => {
  it('matches a unique session by time window, else stays unresolved', async () => {
    const course = await seedCourse();
    await seedSession(course, '2026-09-07T14:00:00Z', '2026-09-07T15:30:00Z');

    expect(await resolveSession(db, '2026-09-07T14:15:00Z')).toMatchObject({ matched: true });
    expect(await resolveSession(db, '2026-09-07T18:00:00Z')).toEqual({ matched: false, reason: 'no_match' });
    expect(await resolveSession(db, null)).toEqual({ matched: false, reason: 'no_timestamp' });

    // Overlapping second session -> ambiguous.
    await seedSession(course, '2026-09-07T14:10:00Z', '2026-09-07T15:00:00Z');
    expect(await resolveSession(db, '2026-09-07T14:15:00Z')).toEqual({ matched: false, reason: 'ambiguous' });
  });
});

describe('processTranscript', () => {
  it('links the session, stores extraction, and emits transcript.processed', async () => {
    const course = await seedCourse();
    const sessionId = await seedSession(course, '2026-09-07T14:00:00Z', '2026-09-07T15:30:00Z');
    const { recordingId, transcriptId } = await seedTranscript('2026-09-07T14:15:00Z');

    await processTranscript(db, bus, transcriptId);

    const rec = await db.query<{ session_id: string | null; res: string }>(
      `SELECT session_id, metadata->>'session_resolution' AS res FROM recordings WHERE id=$1`,
      [recordingId],
    );
    expect(rec.rows[0]).toMatchObject({ session_id: sessionId, res: 'schedule_time_match' });

    const t = await db.query<{ sc: number }>(
      `SELECT (metadata->'extraction'->>'speaker_count')::int AS sc FROM transcripts WHERE id=$1`,
      [transcriptId],
    );
    expect(t.rows[0]!.sc).toBe(2);

    const ev = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE type=$1`,
      [TRANSCRIPT_PROCESSED],
    );
    expect(ev.rows[0]!.n).toBe(1);
  });

  it('stores an unresolved relationship safely when no session matches', async () => {
    const { recordingId, transcriptId } = await seedTranscript('2030-01-01T00:00:00Z');
    await processTranscript(db, bus, transcriptId);
    const rec = await db.query<{ session_id: string | null; res: string }>(
      `SELECT session_id, metadata->>'session_resolution' AS res FROM recordings WHERE id=$1`,
      [recordingId],
    );
    expect(rec.rows[0]).toMatchObject({ session_id: null, res: 'no_match' });
  });
});

describe('auto-processing on transcription.completed', () => {
  it('runs processing when a transcript completes', async () => {
    const storage = new InMemoryStorageProvider();
    const course = await seedCourse();
    await seedSession(course, '2026-09-07T14:00:00Z', '2026-09-07T15:30:00Z');
    const rec = await db.query<{ id: string }>(
      `INSERT INTO recordings (client_id, status, storage_key, content_type, captured_at)
       VALUES ('c1','stored','recordings/k','audio/m4a','2026-09-07T14:15:00Z') RETURNING id`,
    );
    await storage.put('recordings/k', Buffer.from('audio'), 'audio/m4a');
    const t = await requestTranscription(db, rec.rows[0]!.id);

    registerTranscriptProcessor(bus, db);
    await runTranscription(db, storage, new FakeTranscriptionProvider(), bus, t.id);

    const ev = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE type=$1`,
      [TRANSCRIPT_PROCESSED],
    );
    expect(ev.rows[0]!.n).toBe(1);
  });
});
