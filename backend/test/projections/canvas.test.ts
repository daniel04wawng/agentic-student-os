import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CanvasAssignment, CanvasClient, CanvasCourse } from '../../src/canvas/client.js';
import { ingestCanvas } from '../../src/canvas/ingest.js';
import { assignmentToEvent, courseToEvent } from '../../src/canvas/normalize.js';
import { EventBus } from '../../src/events/bus.js';
import {
  registerCanvasProjectors,
  upsertAssignmentFromEvent,
  upsertCourseFromEvent,
} from '../../src/projections/canvas.js';
import { freshDb, resetDb } from '../db/helpers.js';

const trace = randomUUID();
const at = '2026-09-07T12:00:00.000Z';

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

async function count(table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

describe('upsertCourseFromEvent', () => {
  it('inserts once and updates canonical fields on re-projection', async () => {
    await upsertCourseFromEvent(
      db,
      courseToEvent({ id: 1, name: 'CS101', course_code: 'CS-1', time_zone: 'America/New_York' }, trace, at),
    );
    await upsertCourseFromEvent(db, courseToEvent({ id: 1, name: 'CS101 (renamed)' }, trace, at));

    expect(await count('courses')).toBe(1);
    const { rows } = await db.query<{ name: string; tz: string }>(
      `SELECT name, metadata->>'time_zone' AS tz FROM courses WHERE source='canvas' AND source_id='1'`,
    );
    expect(rows[0]).toMatchObject({ name: 'CS101 (renamed)', tz: 'America/New_York' });
  });

  it('preserves our lifecycle status on re-projection', async () => {
    await upsertCourseFromEvent(db, courseToEvent({ id: 2, name: 'X' }, trace, at));
    await db.query(`UPDATE courses SET status='archived' WHERE source_id='2'`);
    await upsertCourseFromEvent(db, courseToEvent({ id: 2, name: 'X2' }, trace, at));
    const { rows } = await db.query<{ status: string; name: string }>(
      `SELECT status, name FROM courses WHERE source_id='2'`,
    );
    expect(rows[0]).toMatchObject({ status: 'archived', name: 'X2' });
  });
});

describe('upsertAssignmentFromEvent', () => {
  beforeEach(async () => {
    await upsertCourseFromEvent(db, courseToEvent({ id: 1, name: 'CS101' }, trace, at));
  });

  it('resolves the course and stores the due date', async () => {
    await upsertAssignmentFromEvent(
      db,
      assignmentToEvent({ id: 11, course_id: 1, name: 'HW1', due_at: '2026-05-01T03:59:00Z' }, trace, at),
    );
    const { rows } = await db.query<{ title: string; has_due: boolean; ok: boolean }>(
      `SELECT a.title, a.due_at IS NOT NULL AS has_due,
              a.course_id = c.id AS ok
       FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.source_id='11'`,
    );
    expect(rows[0]).toMatchObject({ title: 'HW1', has_due: true, ok: true });
  });

  it('preserves lifecycle status while updating canonical fields', async () => {
    await upsertAssignmentFromEvent(db, assignmentToEvent({ id: 11, course_id: 1, name: 'HW1' }, trace, at));
    await db.query(`UPDATE assignments SET status='review_ready' WHERE source_id='11'`);
    await upsertAssignmentFromEvent(db, assignmentToEvent({ id: 11, course_id: 1, name: 'HW1 v2' }, trace, at));
    const { rows } = await db.query<{ status: string; title: string }>(
      `SELECT status, title FROM assignments WHERE source_id='11'`,
    );
    expect(rows[0]).toMatchObject({ status: 'review_ready', title: 'HW1 v2' });
    expect(await count('assignments')).toBe(1);
  });

  it('throws when the course has not been projected yet', async () => {
    await expect(
      upsertAssignmentFromEvent(db, assignmentToEvent({ id: 99, course_id: 777, name: 'orphan' }, trace, at)),
    ).rejects.toThrow(/course canvas_id=777 not found/);
  });
});

describe('projectors via the bus + ingestCanvas', () => {
  const fakeClient: CanvasClient = {
    diagnose: async () => ({ ok: true }),
    listActiveCourses: async (): Promise<CanvasCourse[]> => [
      { id: 1, name: 'CS101' },
      { id: 2, name: 'Math200' },
    ],
    getCourse: async (id): Promise<CanvasCourse> => ({ id, name: 'x' }),
    listAssignments: async (courseId): Promise<CanvasAssignment[]> =>
      courseId === 1
        ? [
            { id: 11, course_id: 1, name: 'HW1' },
            { id: 12, course_id: 1, name: 'HW2' },
          ]
        : [{ id: 21, course_id: 2, name: 'PS1' }],
  };

  it('populates courses and assignments tables end to end', async () => {
    const bus = new EventBus(db);
    registerCanvasProjectors(bus, db);
    await ingestCanvas(fakeClient, bus, { now: () => at });
    expect(await count('courses')).toBe(2);
    expect(await count('assignments')).toBe(3);
  });
});
