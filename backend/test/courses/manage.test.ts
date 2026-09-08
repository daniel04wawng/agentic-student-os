import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listCourses, removeCourse, restoreCourse } from '../../src/courses/manage.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetDb(db); });

async function seed(name: string, canvasId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ($1,'canvas',$2) RETURNING id`,
    [name, canvasId],
  );
  return r.rows[0]!.id;
}

describe('course removal', () => {
  it('removes by canvas id, hides from default list, and is reversible', async () => {
    await seed('Real Course', '100');
    await seed('HBA Community', '200');

    expect(await removeCourse(db, { canvasId: 200 })).toBe(true);

    const visible = await listCourses(db);
    expect(visible.map((c) => c.name)).toEqual(['Real Course']);

    const all = await listCourses(db, { includeRemoved: true });
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.name === 'HBA Community')!.status).toBe('archived');

    // Idempotent: removing again reports no change.
    expect(await removeCourse(db, { canvasId: 200 })).toBe(false);

    // Reversible.
    expect(await restoreCourse(db, { canvasId: 200 })).toBe(true);
    expect((await listCourses(db)).map((c) => c.name).sort()).toEqual(['HBA Community', 'Real Course']);
  });

  it('returns false for an unknown course', async () => {
    expect(await removeCourse(db, { canvasId: 999 })).toBe(false);
  });
});
