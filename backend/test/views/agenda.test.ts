import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAgenda } from '../../src/views/queries.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await resetDb(db); });

async function course(name: string, status = 'active'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO courses (name, status, source, source_id) VALUES ($1,$2,'canvas',$3) RETURNING id`,
    [name, status, name],
  );
  return r.rows[0]!.id;
}

describe('getAgenda', () => {
  it('merges class meetings and deadlines chronologically, excluding removed courses', async () => {
    const now = '2026-09-08T12:00:00Z';
    const macro = await course('Global Macro');
    const removed = await course('HBA Community', 'archived');

    await db.query(
      `INSERT INTO sessions (course_id, title, starts_at) VALUES ($1,'Macro Session 2',$2)`,
      [macro, '2026-09-10T13:40:00Z'],
    );
    await db.query(
      `INSERT INTO assignments (course_id, title, due_at) VALUES ($1,'Problem Set 1',$2)`,
      [macro, '2026-09-09T03:59:00Z'],
    );
    // Both a class and a deadline on the removed course must NOT appear.
    await db.query(
      `INSERT INTO sessions (course_id, title, starts_at) VALUES ($1,'Community Event',$2)`,
      [removed, '2026-09-09T00:00:00Z'],
    );
    await db.query(
      `INSERT INTO assignments (course_id, title, due_at) VALUES ($1,'Ignore Me',$2)`,
      [removed, '2026-09-09T00:00:00Z'],
    );

    const agenda = await getAgenda(db, { now, horizonDays: 14 });
    expect(agenda.map((a) => [a.type, a.title])).toEqual([
      ['deadline', 'Problem Set 1'],
      ['class', 'Macro Session 2'],
    ]);
  });
});
