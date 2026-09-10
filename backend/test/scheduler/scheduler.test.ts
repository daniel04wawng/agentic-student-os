import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prepareUpcoming } from '../../src/classprep/prep.js';
import { EventBus } from '../../src/events/bus.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { startPrepScheduler } from '../../src/scheduler/scheduler.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let bus: EventBus;
const model = new ModelService(
  new FakeModelProvider(() => JSON.stringify({ overview: 'o', analysis: 'a', worked_answer: 'w' })),
);
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetDb(db); bus = new EventBus(db); });

async function seedCourseSession(name: string, withMaterial: boolean, startsAt: string): Promise<void> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ($1,'canvas',$1) RETURNING id`,
    [name],
  );
  const courseId = c.rows[0]!.id;
  await db.query(`INSERT INTO sessions (course_id, kind, starts_at) VALUES ($1,'lecture',$2)`, [courseId, startsAt]);
  if (withMaterial) {
    await db.query(
      `INSERT INTO materials (course_id, kind, text, source, source_id) VALUES ($1,'syllabus',$2,'canvas',$3)`,
      [courseId, 'This course covers X, Y, and Z in detail.', `m-${name}`],
    );
  }
}

describe('prepareUpcoming requireContent', () => {
  it('preps only courses that have materials/summaries', async () => {
    const now = '2026-09-10T12:00:00Z';
    await seedCourseSession('HasContent', true, '2026-09-10T18:00:00Z');
    await seedCourseSession('NoContent', false, '2026-09-10T19:00:00Z');

    const n = await prepareUpcoming(db, bus, model, { now, withinHours: 48, requireContent: true });
    expect(n).toBe(1);

    const preps = await db.query<{ name: string }>(
      `SELECT c.name FROM class_preps p JOIN courses c ON c.id = p.course_id`,
    );
    expect(preps.rows.map((r) => r.name)).toEqual(['HasContent']);
  });
});

describe('startPrepScheduler', () => {
  it('runs a tick on start and prepares upcoming classes', async () => {
    await seedCourseSession('SchedTest', true, '2026-09-10T18:00:00Z');
    const done = new Promise<{ prepared: number }>((resolve) => {
      const stop = startPrepScheduler(db, bus, model, {
        now: () => '2026-09-10T12:00:00Z',
        onTick: (r) => {
          stop();
          resolve(r);
        },
      });
    });
    const r = await done;
    expect(r.prepared).toBe(1);
  });
});
