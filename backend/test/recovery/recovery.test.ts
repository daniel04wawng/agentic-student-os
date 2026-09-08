import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleDocArtifact } from '../../src/artifacts/registry.js';
import { approveArtifact, isApproved } from '../../src/approval/approval.js';
import { FakeGoogleDocsClient } from '../../src/google/client.js';
import { recoverySnapshot } from '../../src/recovery/dashboard.js';
import { detectStaleState, reconcileArtifacts } from '../../src/recovery/reconcile.js';
import { claimDueRetries, enqueueRetry, failRetry } from '../../src/recovery/retry.js';
import { freshDb, resetDb } from '../db/helpers.js';

let db: PGlite;
let google: FakeGoogleDocsClient;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  google = new FakeGoogleDocsClient();
});

describe('retry queue', () => {
  it('enqueues, claims due items, and dies after max attempts', async () => {
    const id = await enqueueRetry(db, { kind: 'submit', maxAttempts: 2 });
    const due = await claimDueRetries(db, new Date(Date.now() + 1000).toISOString());
    expect(due.map((d) => d.id)).toContain(id);

    expect(await failRetry(db, id, 'boom', 0)).toBe('queued'); // attempt 1
    expect(await failRetry(db, id, 'boom', 0)).toBe('dead'); // attempt 2 == max
  });
});

describe('reconcileArtifacts', () => {
  it('detects out-of-band edits and invalidates approvals', async () => {
    const c = await db.query<{ id: string }>(
      `INSERT INTO courses (name, source, source_id) VALUES ('C','canvas','c1') RETURNING id`,
    );
    const a = await db.query<{ id: string }>(
      `INSERT INTO assignments (course_id, title, source, source_id) VALUES ($1,'A','canvas','a1') RETURNING id`,
      [c.rows[0]!.id],
    );
    const d = await db.query<{ id: string }>(
      `INSERT INTO deliverables (assignment_id, title) VALUES ($1,'D') RETURNING id`,
      [a.rows[0]!.id],
    );
    const { artifactId, docId } = await createGoogleDocArtifact(db, google, d.rows[0]!.id, 'E', 'x');
    await approveArtifact(db, { assignmentId: a.rows[0]!.id, artifactId, actor: 'user' });

    // User edits the doc directly (out of band) — our stored revision is now stale.
    await google.updateDoc(docId, 'user changed');

    const res = await reconcileArtifacts(db, google);
    expect(res.drifted).toBe(1);
    expect(await isApproved(db, artifactId)).toBe(false); // approval invalidated
  });
});

describe('detectStaleState', () => {
  it('finds items stuck in a transient state', async () => {
    await db.query(
      `INSERT INTO recordings (client_id, status, updated_at) VALUES ('c1','uploading', now() - interval '2 hours')`,
    );
    const stale = await detectStaleState(db, { now: new Date().toISOString(), thresholdMinutes: 30 });
    expect(stale.some((s) => s.table === 'recordings')).toBe(true);
  });
});

describe('recoverySnapshot', () => {
  it('summarizes failed/dead work', async () => {
    await db.query(`INSERT INTO recordings (client_id, status) VALUES ('c1','failed')`);
    await enqueueRetry(db, { kind: 'x', maxAttempts: 1 });
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM retry_queue LIMIT 1`);
    await failRetry(db, rows[0]!.id, 'e', 0); // -> dead
    const snap = await recoverySnapshot(db);
    expect(snap.failed_recordings).toBe(1);
    expect(snap.dead_retries).toBe(1);
  });
});
