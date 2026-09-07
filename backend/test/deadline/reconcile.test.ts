import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileAssignmentTimezone, reconcilePendingDeadlines } from '../../src/deadline/reconcile.js';
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

let courseSeq = 0;
async function makeCourse(tz: string | null): Promise<string> {
  const meta = tz ? JSON.stringify({ time_zone: tz }) : '{}';
  courseSeq += 1;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id, metadata) VALUES ('C','canvas',$1,$2::jsonb) RETURNING id`,
    [`c${courseSeq}`, meta],
  );
  return rows[0]!.id;
}
async function makeAssignment(courseId: string, dueAt: string | null, tz: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO assignments (course_id, title, due_at, due_source_timezone)
     VALUES ($1,'A',$2,$3) RETURNING id`,
    [courseId, dueAt, tz],
  );
  return rows[0]!.id;
}

describe('reconcileAssignmentTimezone', () => {
  it('falls back to the course timezone and records provenance (idempotent)', async () => {
    const course = await makeCourse('America/New_York');
    const a = await makeAssignment(course, '2026-05-01T03:59:00Z', null);

    const first = await reconcileAssignmentTimezone(db, a);
    expect(first).toMatchObject({ resolution: 'course_fallback', timezone: 'America/New_York' });

    const { rows } = await db.query<{ tz: string; res: string }>(
      `SELECT due_source_timezone AS tz, metadata->>'tz_resolution' AS res FROM assignments WHERE id=$1`,
      [a],
    );
    expect(rows[0]).toMatchObject({ tz: 'America/New_York', res: 'course_fallback' });

    // Idempotent: now explicit, unchanged.
    const second = await reconcileAssignmentTimezone(db, a);
    expect(second.resolution).toBe('explicit');
  });

  it('leaves an explicit source timezone untouched', async () => {
    const course = await makeCourse('America/New_York');
    const a = await makeAssignment(course, '2026-05-01T03:59:00Z', 'America/Chicago');
    const res = await reconcileAssignmentTimezone(db, a);
    expect(res).toMatchObject({ resolution: 'explicit', timezone: 'America/Chicago' });
  });

  it('reports no_deadline when there is no due date', async () => {
    const course = await makeCourse('America/New_York');
    const a = await makeAssignment(course, null, null);
    expect((await reconcileAssignmentTimezone(db, a)).resolution).toBe('no_deadline');
  });

  it('reports unknown when the course has no timezone', async () => {
    const course = await makeCourse(null);
    const a = await makeAssignment(course, '2026-05-01T03:59:00Z', null);
    expect((await reconcileAssignmentTimezone(db, a)).resolution).toBe('unknown');
  });
});

describe('reconcilePendingDeadlines', () => {
  it('counts reconciled vs unresolved across assignments', async () => {
    const withTz = await makeCourse('America/New_York');
    const withoutTz = await makeCourse(null);
    await makeAssignment(withTz, '2026-05-01T03:59:00Z', null); // -> reconciled
    await makeAssignment(withoutTz, '2026-05-01T03:59:00Z', null); // -> unresolved
    await makeAssignment(withTz, null, null); // no deadline: skipped by query

    const res = await reconcilePendingDeadlines(db);
    expect(res).toEqual({ reconciled: 1, unresolved: 1 });
  });
});
