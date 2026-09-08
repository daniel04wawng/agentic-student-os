import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import {
  CLASS_PREP_READY,
  buildPrepDeterministic,
  detectUpcomingClasses,
  prepareClass,
} from '../../src/classprep/prep.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let bus: EventBus;
const model = new ModelService(new FakeModelProvider(() => 'not json')); // force deterministic fallback
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

let seq = 0;
async function seedSession(startsAt: string): Promise<string> {
  seq += 1;
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('Bio','canvas',$1) RETURNING id`,
    [`c${seq}`],
  );
  const s = await db.query<{ id: string }>(
    `INSERT INTO sessions (course_id, kind, starts_at) VALUES ($1,'lecture',$2) RETURNING id`,
    [c.rows[0]!.id, startsAt],
  );
  return s.rows[0]!.id;
}

describe('detectUpcomingClasses', () => {
  it('finds sessions in the window without a prep', async () => {
    await seedSession('2026-09-07T15:00:00Z'); // 3h out
    await seedSession('2026-09-10T15:00:00Z'); // far
    const upcoming = await detectUpcomingClasses(db, { now: '2026-09-07T12:00:00Z', withinHours: 6 });
    expect(upcoming).toHaveLength(1);
  });
});

describe('buildPrepDeterministic', () => {
  it('assembles overview/recap/key_points from context', () => {
    const prep = buildPrepDeterministic({
      courseName: 'Bio',
      priorSummaries: ['s1', 's2', 's3'],
      readings: ['Chapter 1', 'Chapter 2'],
    });
    expect(prep.overview).toContain('Bio');
    expect(prep.prior_recap).toBe('s2 s3'); // last two
    expect(prep.key_points).toEqual(['Chapter 1', 'Chapter 2']);
  });
});

describe('prepareClass', () => {
  it('creates a prep artifact + notification + event, idempotently', async () => {
    const sessionId = await seedSession('2026-09-07T15:00:00Z');
    await prepareClass(db, bus, model, sessionId);
    await prepareClass(db, bus, model, sessionId); // idempotent

    const preps = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM class_preps`);
    const notes = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications`);
    const events = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE type=$1`,
      [CLASS_PREP_READY],
    );
    expect(preps.rows[0]!.n).toBe(1);
    expect(notes.rows[0]!.n).toBe(1); // deduped by dedup_key
    expect(events.rows[0]!.n).toBe(1); // deduped by idempotency key
  });
});
