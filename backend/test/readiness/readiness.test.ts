import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import {
  ASSIGNMENT_CONTEXT_READY,
  createContract,
  evaluate,
  isReady,
  resolveByEvidence,
  reviseContract,
} from '../../src/readiness/readiness.js';
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

async function seedAssignment(): Promise<string> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
  );
  const a = await db.query<{ id: string }>(
    `INSERT INTO assignments (course_id, title, status, source, source_id)
     VALUES ($1,'Essay','not_started','canvas','a1') RETURNING id`,
    [c.rows[0]!.id],
  );
  return a.rows[0]!.id;
}
async function readyEvents(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE type=$1`,
    [ASSIGNMENT_CONTEXT_READY],
  );
  return rows[0]!.n;
}
async function assignmentStatus(id: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM assignments WHERE id=$1`, [id]);
  return rows[0]!.status;
}

describe('isReady', () => {
  it('ignores optional requirements', () => {
    expect(isReady([{ key: 'x', blocking: false, resolved: false }])).toBe(true);
    expect(isReady([{ key: 'x', blocking: true, resolved: false }])).toBe(false);
  });
});

describe('readiness lifecycle', () => {
  it('stays pending while a blocking requirement is unresolved', async () => {
    const a = await seedAssignment();
    await createContract(db, a, [{ key: 'lecture:week5', blocking: true, resolved: false }]);
    expect((await evaluate(db, bus, a)).ready).toBe(false);
    expect(await readyEvents()).toBe(0);
    expect(await assignmentStatus(a)).toBe('not_started');
  });

  it('is ready immediately when there are no blocking requirements', async () => {
    const a = await seedAssignment();
    await createContract(db, a, [{ key: 'reading', blocking: false, resolved: false }]);
    expect((await evaluate(db, bus, a)).ready).toBe(true);
    expect(await readyEvents()).toBe(1);
    expect(await assignmentStatus(a)).toBe('context_ready');
  });

  it('fires context_ready once when evidence resolves the blocker', async () => {
    const a = await seedAssignment();
    await createContract(db, a, [{ key: 'lecture:week5', blocking: true, resolved: false }]);
    await evaluate(db, bus, a);
    expect(await readyEvents()).toBe(0);

    await resolveByEvidence(db, bus, 'lecture:week5');
    expect(await readyEvents()).toBe(1);
    // Re-evaluating does not emit a duplicate.
    await evaluate(db, bus, a);
    expect(await readyEvents()).toBe(1);
  });

  it('an irrelevant event does not affect readiness', async () => {
    const a = await seedAssignment();
    await createContract(db, a, [{ key: 'lecture:week5', blocking: true, resolved: false }]);
    const res = await resolveByEvidence(db, bus, 'lecture:week9'); // not a requirement
    expect(res.affected).toBe(0);
    expect(await readyEvents()).toBe(0);
  });

  it('new evidence can add a dependency (revision)', async () => {
    const a = await seedAssignment();
    await createContract(db, a, [{ key: 'lecture:week5', blocking: true, resolved: true }]);
    expect((await evaluate(db, bus, a)).ready).toBe(true);

    await reviseContract(db, a, [{ key: 'lecture:week6', blocking: true, resolved: false }]);
    expect((await evaluate(db, bus, a)).ready).toBe(false); // newly-added blocker
  });
});
