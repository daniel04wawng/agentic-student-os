import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { generateAndStoreNotes, processPendingLectureNotes } from '../../src/lectures/process.js';
import type { SqlClient } from '../../src/db/client.js';
import { freshDb, insertCourse, resetDb } from '../db/helpers.js';

const validNotes = JSON.stringify({
  summary: 'The lecture covered cost accounting.',
  key_points: ['Fixed vs variable costs', 'Contribution margin'],
  topics: ['managerial accounting'],
  action_items: ['Submit problem set 2 by Friday'],
  questions: ['How is break-even computed?'],
});

const model = new ModelService(new FakeModelProvider(() => validNotes));

/** Insert a stored recording + a transcript row; return the transcript id. */
async function seedTranscript(
  db: PGlite,
  opts: { courseId: string; text: string | null; status?: string },
): Promise<{ transcriptId: string; recordingId: string }> {
  const session = await db.query<{ id: string }>(
    `INSERT INTO sessions (course_id, title, starts_at) VALUES ($1, 'Lecture', now()) RETURNING id`,
    [opts.courseId],
  );
  const sessionId = session.rows[0]!.id;
  const rec = await db.query<{ id: string }>(
    `INSERT INTO recordings (client_id, session_id, status, storage_key, content_type, captured_at)
     VALUES ($1, $2, 'stored', 'key/audio.m4a', 'audio/m4a', now()) RETURNING id`,
    [`c-${Math.random().toString(36).slice(2)}`, sessionId],
  );
  const recordingId = rec.rows[0]!.id;
  const t = await db.query<{ id: string }>(
    `INSERT INTO transcripts (recording_id, status, text, completed_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [recordingId, opts.status ?? 'completed', opts.text],
  );
  return { transcriptId: t.rows[0]!.id, recordingId };
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

describe('generateAndStoreNotes', () => {
  it('stores AI notes and (re)builds chunks + summaries, idempotently', async () => {
    const courseId = await insertCourse(db, 'Managerial Accounting');
    const { transcriptId } = await seedTranscript(db, {
      courseId,
      text: 'Today we discuss fixed and variable costs and the contribution margin. '.repeat(20),
    });

    await generateAndStoreNotes(db as unknown as SqlClient, model, transcriptId);

    const notes = await db.query<{ content: { summary: string; action_items: string[] } }>(
      `SELECT content FROM lecture_notes WHERE transcript_id = $1`,
      [transcriptId],
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]!.content.summary).toContain('cost accounting');
    expect(notes.rows[0]!.content.action_items[0]).toContain('problem set 2');

    // The retrieval pipeline ran too: chunks + a session summary exist.
    const chunks = await db.query(`SELECT 1 FROM transcript_chunks WHERE transcript_id = $1`, [transcriptId]);
    expect(chunks.rows.length).toBeGreaterThan(0);
    const summary = await db.query(`SELECT 1 FROM summaries WHERE transcript_id = $1 AND scope='session'`, [transcriptId]);
    expect(summary.rows).toHaveLength(1);

    // Idempotent: a second run updates in place, no duplicate row.
    await generateAndStoreNotes(db as unknown as SqlClient, model, transcriptId);
    const again = await db.query(`SELECT 1 FROM lecture_notes WHERE transcript_id = $1`, [transcriptId]);
    expect(again.rows).toHaveLength(1);
  });
});

describe('processPendingLectureNotes', () => {
  it('notes only completed transcripts that lack notes, and skips the rest', async () => {
    const courseId = await insertCourse(db, 'Economics');
    const done = await seedTranscript(db, { courseId, text: 'supply and demand basics '.repeat(20) });
    // A still-processing transcript must be ignored.
    await seedTranscript(db, { courseId, text: 'partial ...', status: 'processing' });
    // A completed-but-empty transcript has nothing to summarize.
    await seedTranscript(db, { courseId, text: '', status: 'completed' });

    const count = await processPendingLectureNotes(db as unknown as SqlClient, model);
    expect(count).toBe(1);

    const rows = await db.query(`SELECT transcript_id FROM lecture_notes`);
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { transcript_id: string }).transcript_id).toBe(done.transcriptId);

    // Running again finds nothing new to do.
    expect(await processPendingLectureNotes(db as unknown as SqlClient, model)).toBe(0);
  });
});
