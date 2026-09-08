import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import {
  ASSIGNMENT_REVIEW_READY,
  generateAssignment,
  qaCheck,
  transitionToReviewReady,
} from '../../src/generation/generate.js';
import { FakeGoogleDocsClient } from '../../src/google/client.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let bus: EventBus;
let google: FakeGoogleDocsClient;
const model = new ModelService(new FakeModelProvider(() => 'not json')); // deterministic fallbacks
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  bus = new EventBus(db);
  google = new FakeGoogleDocsClient();
});

async function seedAssignment(): Promise<string> {
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
  );
  const a = await db.query<{ id: string }>(
    `INSERT INTO assignments (course_id, title, status, source, source_id)
     VALUES ($1,'Photosynthesis Essay','context_ready','canvas','a1') RETURNING id`,
    [c.rows[0]!.id],
  );
  return a.rows[0]!.id;
}

describe('qaCheck', () => {
  it('requires an artifact and a minimum body', () => {
    expect(qaCheck('a'.repeat(50), false).pass).toBe(false); // no artifact
    expect(qaCheck('short', true).pass).toBe(false); // too short
    expect(qaCheck('a'.repeat(50), true).pass).toBe(true);
  });
});

describe('generateAssignment', () => {
  it('drafts, creates an artifact, and reaches review_ready', async () => {
    const id = await seedAssignment();
    const res = await generateAssignment(db, { model, google, bus }, id);
    expect(res.reviewReady).toBe(true);

    const asg = await db.query<{ status: string }>(`SELECT status FROM assignments WHERE id=$1`, [id]);
    expect(asg.rows[0]!.status).toBe('review_ready');

    const art = await db.query<{ status: string; kind: string }>(
      `SELECT status, kind FROM artifacts WHERE id=$1`,
      [res.artifactId],
    );
    expect(art.rows[0]).toMatchObject({ status: 'review_ready', kind: 'google_doc' });

    const ev = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE type=$1`,
      [ASSIGNMENT_REVIEW_READY],
    );
    expect(ev.rows[0]!.n).toBe(1);
  });
});

describe('review_ready requires an artifact (invariant)', () => {
  it('transitionToReviewReady throws without an artifact for the assignment', async () => {
    const id = await seedAssignment();
    await expect(
      transitionToReviewReady(db, id, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/no artifact/);
    const asg = await db.query<{ status: string }>(`SELECT status FROM assignments WHERE id=$1`, [id]);
    expect(asg.rows[0]!.status).toBe('context_ready'); // unchanged
  });
});
