import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDeadlines, getReview, getToday } from '../../src/views/queries.js';
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

async function seedCourse(tz: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id, metadata)
     VALUES ('CS101','canvas','c1', jsonb_build_object('time_zone',$1::text)) RETURNING id`,
    [tz],
  );
  return rows[0]!.id;
}
async function seedAssignment(
  courseId: string,
  title: string,
  dueAt: string | null,
  status = 'not_started',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO assignments (course_id, title, due_at, status, source, source_id)
     VALUES ($1,$2,$3,$4,'canvas',$2) RETURNING id`,
    [courseId, title, dueAt, status],
  );
  return rows[0]!.id;
}

describe('getDeadlines', () => {
  it('returns dated assignments resolved into source + current timezones, sorted', async () => {
    const course = await seedCourse('America/New_York');
    await seedAssignment(course, 'Later', '2026-05-10T03:59:00Z');
    await seedAssignment(course, 'Sooner', '2026-05-01T03:59:00Z');
    await seedAssignment(course, 'NoDue', null);

    const list = await getDeadlines(db, {
      now: '2026-04-01T00:00:00Z',
      currentTimezone: 'America/Los_Angeles',
      horizonDays: 60,
    });
    expect(list.map((d) => d.title)).toEqual(['Sooner', 'Later']);
    expect(list[0]!.deadline.source.timezone).toBe('America/New_York');
    expect(list[0]!.deadline.source.display?.wall_clock).toBe('2026-04-30 23:59');
    expect(list[0]!.deadline.current.timezone).toBe('America/Los_Angeles');
  });
});

describe('getReview', () => {
  it('returns review_ready notifications and assignments', async () => {
    const course = await seedCourse('UTC');
    await seedAssignment(course, 'InReview', '2026-05-01T00:00:00Z', 'review_ready');
    await db.query(
      `INSERT INTO notifications (kind, title) VALUES ('review_ready','Essay ready to review')`,
    );
    await db.query(`INSERT INTO notifications (kind, title) VALUES ('info','ignore me')`);

    const review = await getReview(db);
    expect(review.assignments.map((a) => a.title)).toEqual(['InReview']);
    expect(review.notifications).toHaveLength(1);
    expect(review.notifications[0]!.title).toBe('Essay ready to review');
  });
});

describe('getToday', () => {
  it("includes today's deadlines (in the current tz) and active notifications", async () => {
    const course = await seedCourse('America/New_York');
    await seedAssignment(course, 'DueToday', '2026-09-07T20:00:00Z'); // 16:00 NY, 2026-09-07
    await seedAssignment(course, 'DueLater', '2026-09-20T20:00:00Z');
    await db.query(`INSERT INTO notifications (kind, title) VALUES ('info','hello')`);

    const today = await getToday(db, {
      now: '2026-09-07T18:00:00Z',
      currentTimezone: 'America/New_York',
    });
    expect(today.date).toBe('2026-09-07');
    expect(today.deadlines.map((d) => d.title)).toEqual(['DueToday']);
    expect(today.notifications).toHaveLength(1);
  });
});
