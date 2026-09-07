import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { indexTranscript } from '../../src/retrieval/index-service.js';
import { buildCourseSummary, buildTranscriptSummaries } from '../../src/retrieval/summarize.js';
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

let seq = 0;
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
  return t.id;
}

async function summaryCount(scope: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM summaries WHERE scope = $1`,
    [scope],
  );
  return rows[0]!.n;
}

describe('buildTranscriptSummaries', () => {
  it('creates section + session summaries and is idempotent', async () => {
    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
    );
    const t = await seedLecture(course.rows[0]!.id, 'Alpha beta gamma delta epsilon.');

    const first = await buildTranscriptSummaries(db, t);
    expect(first.sections).toBeGreaterThan(0);
    expect(await summaryCount('section')).toBe(first.sections);
    expect(await summaryCount('session')).toBe(1);

    await buildTranscriptSummaries(db, t); // idempotent upsert
    expect(await summaryCount('section')).toBe(first.sections);
    expect(await summaryCount('session')).toBe(1);
  });
});

describe('buildCourseSummary', () => {
  it('rolls up session summaries into one course summary', async () => {
    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
    );
    const courseId = course.rows[0]!.id;
    const t1 = await seedLecture(courseId, 'Photosynthesis lecture content here.');
    const t2 = await seedLecture(courseId, 'Cellular respiration lecture content.');
    await buildTranscriptSummaries(db, t1);
    await buildTranscriptSummaries(db, t2);

    await buildCourseSummary(db, courseId);
    expect(await summaryCount('course')).toBe(1);
    const { rows } = await db.query<{ text: string }>(
      `SELECT text FROM summaries WHERE scope='course' AND course_id=$1`,
      [courseId],
    );
    expect(rows[0]!.text.toLowerCase()).toContain('photosynthesis');
    expect(rows[0]!.text.toLowerCase()).toContain('respiration');
  });
});
