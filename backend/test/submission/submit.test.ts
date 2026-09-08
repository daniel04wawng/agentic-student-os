import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approveArtifact } from '../../src/approval/approval.js';
import { FakeCanvasSubmitClient } from '../../src/canvas/submit.js';
import { EventBus } from '../../src/events/bus.js';
import { generateAssignment } from '../../src/generation/generate.js';
import { FakeGoogleDocsClient } from '../../src/google/client.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { ASSIGNMENT_SUBMITTED, submitAssignment } from '../../src/submission/submit.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let bus: EventBus;
let google: FakeGoogleDocsClient;
const model = new ModelService(new FakeModelProvider(() => 'not json'));
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

let seq = 0;
async function reviewReady(): Promise<{ assignmentId: string; artifactId: string }> {
  seq += 1;
  const c = await db.query<{ id: string }>(
    `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas',$1) RETURNING id`,
    [`course-${seq}`],
  );
  const a = await db.query<{ id: string }>(
    `INSERT INTO assignments (course_id, title, status, source, source_id)
     VALUES ($1,'Essay','context_ready','canvas',$2) RETURNING id`,
    [c.rows[0]!.id, `asg-${seq}`],
  );
  const res = await generateAssignment(db, { model, google, bus }, a.rows[0]!.id);
  return { assignmentId: a.rows[0]!.id, artifactId: res.artifactId };
}
async function submissionStatus(assignmentId: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM submissions WHERE assignment_id=$1`,
    [assignmentId],
  );
  return rows[0]?.status ?? 'none';
}

describe('submitAssignment', () => {
  it('REFUSES to submit when review is required and there is no approval', async () => {
    const { assignmentId } = await reviewReady();
    const canvas = new FakeCanvasSubmitClient();
    const outcome = await submitAssignment(db, canvas, { bus }, assignmentId);
    expect(outcome).toMatchObject({ status: 'refused', reason: 'not_approved' });
    expect(canvas.submitCount).toBe(0); // never called Canvas
    expect(await submissionStatus(assignmentId)).toBe('pending');
  });

  it('submits the approved artifact and only marks verified after read-back', async () => {
    const { assignmentId, artifactId } = await reviewReady();
    await approveArtifact(db, { assignmentId, artifactId, actor: 'user' });
    const canvas = new FakeCanvasSubmitClient();

    const outcome = await submitAssignment(db, canvas, { bus }, assignmentId);
    expect(outcome.status).toBe('verified');
    expect(await submissionStatus(assignmentId)).toBe('verified');
    const asg = await db.query<{ status: string }>(`SELECT status FROM assignments WHERE id=$1`, [assignmentId]);
    expect(asg.rows[0]!.status).toBe('submitted');
    const ev = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [ASSIGNMENT_SUBMITTED]);
    expect(ev.rows[0]!.n).toBe(1);
  });

  it('is idempotent: a verified submission is never re-sent', async () => {
    const { assignmentId, artifactId } = await reviewReady();
    await approveArtifact(db, { assignmentId, artifactId, actor: 'user' });
    const canvas = new FakeCanvasSubmitClient();
    await submitAssignment(db, canvas, { bus }, assignmentId);
    const again = await submitAssignment(db, canvas, { bus }, assignmentId);
    expect(again).toMatchObject({ status: 'already_submitted' });
    expect(canvas.submitCount).toBe(1); // no second submit
  });

  it('does NOT claim success when Canvas verification fails', async () => {
    const { assignmentId, artifactId } = await reviewReady();
    await approveArtifact(db, { assignmentId, artifactId, actor: 'user' });
    const canvas = new FakeCanvasSubmitClient({ failVerify: true });
    const outcome = await submitAssignment(db, canvas, { bus }, assignmentId);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'verification_failed' });
    expect(await submissionStatus(assignmentId)).toBe('failed');
    const asg = await db.query<{ status: string }>(`SELECT status FROM assignments WHERE id=$1`, [assignmentId]);
    expect(asg.rows[0]!.status).not.toBe('submitted');
  });

  it('permits submission without approval under an auto policy', async () => {
    const { assignmentId } = await reviewReady();
    await db.query(
      `UPDATE assignments SET metadata = metadata || jsonb_build_object('permission_policy','auto') WHERE id=$1`,
      [assignmentId],
    );
    const canvas = new FakeCanvasSubmitClient();
    expect((await submitAssignment(db, canvas, { bus }, assignmentId)).status).toBe('verified');
  });
});
