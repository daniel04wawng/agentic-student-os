import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import {
  CAPABILITY_REQUESTED,
  STUDENT_PLAN,
  deterministicPlan,
  gatherWorldState,
  generatePlan,
  runPlan,
} from '../../src/planner/planner.js';
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

async function seedAssignments(): Promise<void> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
  );
  const cid = c.rows[0]!.id;
  await db.query(
    `INSERT INTO assignments (course_id, title, status, due_at, source, source_id) VALUES
       ($1,'Ready','context_ready','2026-12-01T00:00:00Z','canvas','a1'),
       ($1,'Todo','not_started','2026-12-10T00:00:00Z','canvas','a2'),
       ($1,'Done','submitted',NULL,'canvas','a3')`,
    [cid],
  );
}

describe('gatherWorldState', () => {
  it('returns active assignments (excludes submitted/archived)', async () => {
    await seedAssignments();
    const state = await gatherWorldState(db);
    expect(state.assignments.map((a) => a.title).sort()).toEqual(['Ready', 'Todo']);
  });
});

describe('deterministicPlan', () => {
  it('plans generate for context_ready and plan_assignment for upcoming not_started', () => {
    const plan = deterministicPlan({
      assignments: [
        { id: '1', title: 'A', status: 'context_ready', due_at: '2026-12-01T00:00:00Z' },
        { id: '2', title: 'B', status: 'not_started', due_at: '2026-12-10T00:00:00Z' },
      ],
    });
    expect(plan.steps.map((s) => s.capability)).toEqual(['generate_assignment', 'plan_assignment']);
  });
});

describe('generatePlan', () => {
  it('uses the model output when valid', async () => {
    await seedAssignments();
    const model = new ModelService(
      new FakeModelProvider(() => '{"summary":"m","steps":[{"capability":"summarize_course"}]}'),
    );
    const plan = await generatePlan(db, model);
    expect(plan.steps[0]!.capability).toBe('summarize_course');
  });

  it('falls back to the deterministic plan when the model is unusable', async () => {
    await seedAssignments();
    const model = new ModelService(new FakeModelProvider(() => 'not json'));
    const plan = await generatePlan(db, model);
    // deterministic: Ready->generate, Todo->plan_assignment
    expect(plan.steps.map((s) => s.capability).sort()).toEqual([
      'generate_assignment',
      'plan_assignment',
    ]);
  });
});

describe('runPlan', () => {
  it('emits student.plan and one capability.requested per step', async () => {
    await seedAssignments();
    const bus = new EventBus(db);
    const model = new ModelService(new FakeModelProvider(() => 'invalid')); // -> deterministic (2 steps)
    const { plan } = await runPlan(db, bus, model);
    expect(plan.steps).toHaveLength(2);

    const planEvents = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE type=$1`,
      [STUDENT_PLAN],
    );
    const capEvents = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE type=$1`,
      [CAPABILITY_REQUESTED],
    );
    expect(planEvents.rows[0]!.n).toBe(1);
    expect(capEvents.rows[0]!.n).toBe(2);
  });
});
