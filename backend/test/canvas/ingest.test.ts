import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CanvasAssignment, CanvasClient, CanvasCourse } from '../../src/canvas/client.js';
import { ingestCanvas } from '../../src/canvas/ingest.js';
import { EventBus } from '../../src/events/bus.js';
import { freshDb, resetDb } from '../db/helpers.js';

// Fake Canvas: 2 courses, 3 assignments total. No network.
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

async function eventCount(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE source = 'canvas'`,
  );
  return rows[0]!.n;
}

describe('ingestCanvas', () => {
  it('publishes normalized course + assignment events', async () => {
    const bus = new EventBus(db);
    const res = await ingestCanvas(fakeClient, bus, { now: () => '2026-09-07T12:00:00.000Z' });
    expect(res).toMatchObject({ courses: 2, assignments: 3, duplicates: 0 });
    expect(await eventCount()).toBe(5);

    const { rows } = await db.query<{ type: string; n: number }>(
      `SELECT type, count(*)::int AS n FROM events GROUP BY type ORDER BY type`,
    );
    expect(rows).toEqual([
      { type: 'canvas.assignment.discovered', n: 3 },
      { type: 'canvas.course.discovered', n: 2 },
    ]);
  });

  it('is idempotent: re-ingesting the same Canvas state creates no duplicates', async () => {
    const bus = new EventBus(db);
    await ingestCanvas(fakeClient, bus, { now: () => '2026-09-07T12:00:00.000Z' });
    const second = await ingestCanvas(fakeClient, bus, { now: () => '2026-09-08T09:00:00.000Z' });

    expect(second.duplicates).toBe(5); // every object already seen
    expect(await eventCount()).toBe(5); // still exactly 5 rows
  });
});
