import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COURSE_ARCHIVED, archiveCourse, detectCourseEndState } from '../../src/archival/archive.js';
import { isPaused } from '../../src/control/apply.js';
import { EventBus } from '../../src/events/bus.js';
import { indexTranscript } from '../../src/retrieval/index-service.js';
import { fullTextSearch } from '../../src/retrieval/search.js';
import { requestTranscription } from '../../src/transcription/service.js';
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
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
  );
  return c.rows[0]!.id;
}
async function addAssignment(courseId: string, status: string, sid: string): Promise<void> {
  await db.query(
    `INSERT INTO assignments (course_id, title, status, source, source_id) VALUES ($1,'A',$2,'canvas',$3)`,
    [courseId, status, sid],
  );
}
async function seedSearchableMemory(courseId: string): Promise<void> {
  const s = await db.query<{ id: string }>(
    `INSERT INTO sessions (course_id, kind, starts_at) VALUES ($1,'lecture', now()) RETURNING id`,
    [courseId],
  );
  const r = await db.query<{ id: string }>(
    `INSERT INTO recordings (client_id, status, session_id) VALUES ('c1','stored',$1) RETURNING id`,
    [s.rows[0]!.id],
  );
  const t = await requestTranscription(db, r.rows[0]!.id);
  await db.query(
    `UPDATE transcripts SET status='completed', utterances=$2::jsonb WHERE id=$1`,
    [t.id, JSON.stringify([{ speaker: 0, start: 0, end: 3, text: 'Photosynthesis lecture content.' }])],
  );
  await indexTranscript(db, t.id);
}

describe('remaining-deliverable checks', () => {
  it('refuses to archive while deliverables remain, unless forced', async () => {
    const course = await seedCourse();
    await addAssignment(course, 'not_started', 'a1');
    expect(await detectCourseEndState(db, course)).toBe(false);

    const refused = await archiveCourse(db, bus, course);
    expect(refused).toMatchObject({ archived: false, reason: 'remaining_deliverables', remaining: 1 });

    const forced = await archiveCourse(db, bus, course, { force: true });
    expect(forced).toEqual({ archived: true });
  });
});

describe('archiveCourse', () => {
  it('archives, pauses proactive workflows, and preserves searchable memory', async () => {
    const course = await seedCourse();
    await addAssignment(course, 'submitted', 'a1');
    await seedSearchableMemory(course);
    expect(await detectCourseEndState(db, course)).toBe(true);

    const result = await archiveCourse(db, bus, course);
    expect(result).toEqual({ archived: true });

    const c = await db.query<{ status: string }>(`SELECT status FROM courses WHERE id=$1`, [course]);
    expect(c.rows[0]!.status).toBe('archived');
    expect(await isPaused(db, course)).toBe(true); // proactive work stopped

    // Searchable memory preserved: chunks still there and FTS still works.
    const chunks = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM transcript_chunks`);
    expect(chunks.rows[0]!.n).toBeGreaterThan(0);
    expect((await fullTextSearch(db, 'photosynthesis')).length).toBeGreaterThan(0);

    const ev = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [COURSE_ARCHIVED]);
    expect(ev.rows[0]!.n).toBe(1);
  });
});
