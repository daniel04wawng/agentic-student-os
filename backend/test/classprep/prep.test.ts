import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import {
  CLASS_PREP_READY,
  buildPrepDeterministic,
  detectUpcomingClasses,
  gatherPrepContext,
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
      materials: [{ title: 'Case A', kind: 'case', text: 'revenue 500' }],
    });
    expect(prep.overview).toContain('Bio');
    expect(prep.prior_recap).toBe('s2 s3'); // last two
    expect(prep.key_points).toEqual(['Chapter 1', 'Chapter 2', 'Case A']);
    // No model in the deterministic path: worked sections stay empty, never faked.
    expect(prep.analysis).toBe('');
    expect(prep.worked_answer).toBe('');
  });
});

async function sessionCourse(sessionId: string): Promise<string> {
  const r = await db.query<{ course_id: string }>(`SELECT course_id FROM sessions WHERE id=$1`, [sessionId]);
  return r.rows[0]!.course_id;
}

describe('gatherPrepContext', () => {
  it('pulls materials cases-first and bounds their length', async () => {
    const sessionId = await seedSession('2026-09-07T15:00:00Z');
    const courseId = await sessionCourse(sessionId);
    await db.query(
      `INSERT INTO materials (course_id, kind, title, text, source, source_id) VALUES ($1,'reading','R',$2,'canvas','r1')`,
      [courseId, 'reading body with enough length to pass the floor'],
    );
    await db.query(
      `INSERT INTO materials (course_id, kind, title, text, source, source_id) VALUES ($1,'case','Big Case',$2,'canvas','c1')`,
      [courseId, 'X'.repeat(50_000)], // huge; must be truncated
    );
    const ctx = await gatherPrepContext(db, sessionId);
    expect(ctx.materials[0]!.kind).toBe('case'); // cases first
    expect(ctx.materials[0]!.text.length).toBeLessThanOrEqual(9000); // per-material cap
    expect(ctx.materials.map((m) => m.title)).toContain('R');
  });
});

describe('prepareClass with a case', () => {
  it('feeds material text to the model and stores the worked answer', async () => {
    const sessionId = await seedSession('2026-09-07T15:00:00Z');
    const courseId = await sessionCourse(sessionId);
    await db.query(
      `INSERT INTO materials (course_id, kind, title, text, source, source_id) VALUES ($1,'case','Widget Co',$2,'canvas','c9')`,
      [courseId, 'Widget Co revenue is 500 and cost is 300.'],
    );
    let seenPrompt = '';
    const capturing = new ModelService(
      new FakeModelProvider((req) => {
        seenPrompt = req.messages.map((m) => m.content).join('\n');
        return JSON.stringify({
          overview: 'Widget Co decision',
          analysis: 'Profit = 500 - 300 = 200.',
          worked_answer: 'Recommend entering: profit of 200.',
        });
      }),
    );
    await prepareClass(db, bus, capturing, sessionId);
    expect(seenPrompt).toContain('revenue is 500'); // real case text reached the model
    const row = await db.query<{ content: { analysis: string; worked_answer: string } }>(
      `SELECT content FROM class_preps WHERE session_id=$1`,
      [sessionId],
    );
    expect(row.rows[0]!.content.analysis).toContain('200');
    expect(row.rows[0]!.content.worked_answer).toContain('Recommend');
  });
});

describe('prepareClass', () => {
  it('creates a prep artifact + event, idempotently (no standing notification)', async () => {
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
    // Prep no longer creates a standing in-app notification (it piled up with no
    // way to dismiss); the Prep tab + the phone reminder cover it.
    expect(notes.rows[0]!.n).toBe(0);
    expect(events.rows[0]!.n).toBe(1); // deduped by idempotency key
  });
});
