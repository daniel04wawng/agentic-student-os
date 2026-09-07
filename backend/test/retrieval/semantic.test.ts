import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbedder } from '../../src/retrieval/embed.js';
import { embedTranscriptChunks, indexTranscript } from '../../src/retrieval/index-service.js';
import { semanticSearch } from '../../src/retrieval/search.js';
import { requestTranscription } from '../../src/transcription/service.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
const embedder = new FakeEmbedder();
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

async function seedCourse(): Promise<string> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('Bio','canvas','c1') RETURNING id`,
  );
  return c.rows[0]!.id;
}

let seq = 0;
/** One lecture -> one recording+transcript with a single utterance, indexed. */
async function seedLecture(courseId: string, text: string): Promise<string> {
  seq += 1;
  const session = await db.query<{ id: string }>(
    `INSERT INTO sessions (course_id, kind, starts_at) VALUES ($1,'lecture', now()) RETURNING id`,
    [courseId],
  );
  const rec = await db.query<{ id: string }>(
    `INSERT INTO recordings (client_id, status, storage_key, content_type, session_id)
     VALUES ($1,'stored','recordings/k','audio/m4a',$2) RETURNING id`,
    [`c${seq}`, session.rows[0]!.id],
  );
  const t = await requestTranscription(db, rec.rows[0]!.id);
  await db.query(`UPDATE transcripts SET status='completed', utterances=$2::jsonb WHERE id=$1`, [
    t.id,
    JSON.stringify([{ speaker: 0, start: 0, end: 3, text }]),
  ]);
  await indexTranscript(db, t.id);
  await embedTranscriptChunks(db, embedder, t.id);
  return t.id;
}

describe('embedTranscriptChunks', () => {
  it('embeds unembedded chunks and is idempotent', async () => {
    const course = await seedCourse();
    const t = await seedLecture(course, 'Photosynthesis converts light energy in chloroplasts.');
    // seedLecture already embedded once; a re-run finds nothing to embed.
    expect(await embedTranscriptChunks(db, embedder, t)).toBe(0);
  });
});

describe('semanticSearch', () => {
  it('ranks the semantically-closest chunk first', async () => {
    const course = await seedCourse();
    await seedLecture(course, 'Photosynthesis converts light energy in chloroplasts.');
    await seedLecture(course, 'Mitochondria produce ATP the cellular powerhouse.');

    const hits = await semanticSearch(db, embedder, 'chloroplast light photosynthesis', {
      courseId: course,
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.text.toLowerCase()).toContain('photosynthesis');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('respects the course filter', async () => {
    const course = await seedCourse();
    await seedLecture(course, 'Photosynthesis converts light energy in chloroplasts.');
    const none = await semanticSearch(db, embedder, 'photosynthesis', {
      courseId: '00000000-0000-0000-0000-000000000000',
    });
    expect(none).toHaveLength(0);
  });
});
