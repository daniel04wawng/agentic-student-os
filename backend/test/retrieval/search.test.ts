import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { indexTranscript } from '../../src/retrieval/index-service.js';
import { fullTextSearch } from '../../src/retrieval/search.js';
import { requestTranscription } from '../../src/transcription/service.js';
import { freshDb, resetDb } from '../db/helpers.js';

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

async function seedTranscript(): Promise<{ transcriptId: string; courseId: string }> {
  const course = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('Bio','canvas','c1') RETURNING id`,
  );
  const courseId = course.rows[0]!.id;
  const session = await db.query<{ id: string }>(
    `INSERT INTO sessions (course_id, kind, starts_at) VALUES ($1,'lecture', now()) RETURNING id`,
    [courseId],
  );
  const rec = await db.query<{ id: string }>(
    `INSERT INTO recordings (client_id, status, storage_key, content_type, session_id)
     VALUES ('c1','stored','recordings/k','audio/m4a',$1) RETURNING id`,
    [session.rows[0]!.id],
  );
  const t = await requestTranscription(db, rec.rows[0]!.id);
  await db.query(
    `UPDATE transcripts SET status='completed', utterances=$2::jsonb WHERE id=$1`,
    [
      t.id,
      JSON.stringify([
        { speaker: 0, start: 0, end: 3, text: 'Today we discuss photosynthesis and chloroplasts.' },
        { speaker: 1, start: 3, end: 6, text: 'The mitochondria is the powerhouse of the cell.' },
      ]),
    ],
  );
  return { transcriptId: t.id, courseId };
}

describe('indexTranscript', () => {
  it('creates chunks with course context and is idempotent', async () => {
    const { transcriptId, courseId } = await seedTranscript();
    const n1 = await indexTranscript(db, transcriptId);
    expect(n1).toBeGreaterThan(0);

    const { rows } = await db.query<{ n: number; cid: string }>(
      `SELECT count(*)::int AS n, min(course_id::text) AS cid FROM transcript_chunks`,
    );
    expect(rows[0]!.n).toBe(n1);
    expect(rows[0]!.cid).toBe(courseId);

    const n2 = await indexTranscript(db, transcriptId); // re-index replaces
    expect(n2).toBe(n1);
    const after = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM transcript_chunks`);
    expect(after.rows[0]!.n).toBe(n1);
  });
});

describe('fullTextSearch', () => {
  it('finds relevant chunks and respects the course filter', async () => {
    const { transcriptId, courseId } = await seedTranscript();
    await indexTranscript(db, transcriptId);

    const hits = await fullTextSearch(db, 'photosynthesis');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text.toLowerCase()).toContain('photosynthesis');

    expect(await fullTextSearch(db, 'photosynthesis', { courseId })).toHaveLength(hits.length);
    expect(
      await fullTextSearch(db, 'photosynthesis', { courseId: '00000000-0000-0000-0000-000000000000' }),
    ).toHaveLength(0);

    expect(await fullTextSearch(db, 'quantum entanglement')).toHaveLength(0);
  });
});
