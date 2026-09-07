import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CanvasContentClient } from '../../src/canvas/client.js';
import type { CanvasAssignment, CanvasCourse } from '../../src/canvas/types.js';
import { EventBus } from '../../src/events/bus.js';
import { onboardCourse } from '../../src/onboarding/onboard.js';
import { registerCanvasProjectors } from '../../src/projections/canvas.js';
import { freshDb, resetDb } from '../db/helpers.js';

const NOW = '2026-09-07T12:00:00.000Z';

function makeClient(overrides: Partial<CanvasContentClient> = {}): CanvasContentClient {
  return {
    diagnose: async () => ({ ok: true }),
    listActiveCourses: async () => [],
    getCourse: async (id): Promise<CanvasCourse> => ({
      id,
      name: 'CS101',
      course_code: 'CS-1',
      time_zone: 'America/New_York',
      syllabus_body: '<p>Read the book</p>',
    }),
    listAssignments: async (): Promise<CanvasAssignment[]> => [
      { id: 11, course_id: 1, name: 'HW1', due_at: '2026-12-01T05:00:00Z', points_possible: 10 },
      { id: 12, course_id: 1, name: 'HW2' },
    ],
    listModules: async () => [
      { id: 1, name: 'Intro' },
      { id: 2, name: 'Week 2' },
    ],
    listAnnouncements: async () => [{ id: 9, title: 'Welcome' }],
    listDiscussions: async () => [{ id: 5, title: 'Q&A' }],
    ...overrides,
  };
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

async function count(table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

describe('onboardCourse', () => {
  it('ingests canonical objects and writes a course profile + planning summary', async () => {
    const bus = new EventBus(db);
    registerCanvasProjectors(bus, db);
    const res = await onboardCourse(makeClient(), bus, db, 1, { now: () => NOW });

    expect(res).toMatchObject({ assignments: 2, modules: 2, announcements: 1, discussions: 1 });
    expect(await count('courses')).toBe(1);
    expect(await count('assignments')).toBe(2);
    expect(await count('course_profiles')).toBe(1);

    const { rows } = await db.query<{ profile: Record<string, unknown>; planning: Record<string, unknown> }>(
      `SELECT profile, planning_summary AS planning FROM course_profiles`,
    );
    expect((rows[0]!.profile as { counts: { assignments: number } }).counts.assignments).toBe(2);
    expect((rows[0]!.planning as { upcoming_deadlines: unknown[] }).upcoming_deadlines).toHaveLength(1);
  });

  it('is idempotent: re-onboarding keeps one course/profile and updates it', async () => {
    const bus = new EventBus(db);
    registerCanvasProjectors(bus, db);
    await onboardCourse(makeClient(), bus, db, 1, { now: () => NOW });
    await onboardCourse(makeClient(), bus, db, 1, { now: () => '2026-09-08T00:00:00.000Z' });

    expect(await count('courses')).toBe(1);
    expect(await count('assignments')).toBe(2);
    expect(await count('course_profiles')).toBe(1);
  });

  it('is resilient when ancillary content is inaccessible', async () => {
    const bus = new EventBus(db);
    registerCanvasProjectors(bus, db);
    const client = makeClient({
      listModules: async () => {
        throw new Error('403 forbidden');
      },
    });
    const res = await onboardCourse(client, bus, db, 1, { now: () => NOW });
    expect(res.modules).toBe(0); // best-effort: failure yields empty, onboarding still succeeds
    expect(await count('course_profiles')).toBe(1);
  });
});
