import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeAgentEdit } from '../../src/artifacts/edit.js';
import { createGoogleDocArtifact } from '../../src/artifacts/registry.js';
import {
  approveArtifact,
  getPermissionPolicy,
  isApproved,
} from '../../src/approval/approval.js';
import { FakeGoogleDocsClient } from '../../src/google/client.js';
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

async function seedArtifact(): Promise<{ assignmentId: string; artifactId: string }> {
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
  const { artifactId } = await createGoogleDocArtifact(db, google, d.rows[0]!.id, 'E', 'content');
  return { assignmentId: a.rows[0]!.id, artifactId };
}

describe('getPermissionPolicy', () => {
  it('defaults to require_review', async () => {
    const { assignmentId } = await seedArtifact();
    expect(await getPermissionPolicy(db, assignmentId)).toBe('require_review');
  });
});

describe('versioned approval', () => {
  it('approves the exact current version', async () => {
    const { assignmentId, artifactId } = await seedArtifact();
    await approveArtifact(db, { assignmentId, artifactId, actor: 'user' });
    expect(await isApproved(db, artifactId)).toBe(true);
  });

  it('INVALIDATES approval on any post-approval modification', async () => {
    const { assignmentId, artifactId } = await seedArtifact();
    await approveArtifact(db, { assignmentId, artifactId, actor: 'user' });
    expect(await isApproved(db, artifactId)).toBe(true);

    // Any edit advances the version -> approval no longer valid.
    await safeAgentEdit(db, google, artifactId, (c) => `${c} changed`);
    expect(await isApproved(db, artifactId)).toBe(false);

    // Audit trail: the invalidated approval is retained with a reason.
    const { rows } = await db.query<{ status: string; reason: string }>(
      `SELECT status, reason FROM approvals WHERE artifact_id=$1`,
      [artifactId],
    );
    expect(rows[0]).toMatchObject({ status: 'invalidated', reason: 'post_approval_modification' });
  });

  it('re-approval after a change is valid again', async () => {
    const { assignmentId, artifactId } = await seedArtifact();
    await approveArtifact(db, { assignmentId, artifactId, actor: 'user' });
    await safeAgentEdit(db, google, artifactId, (c) => `${c}!`);
    expect(await isApproved(db, artifactId)).toBe(false);
    await approveArtifact(db, { assignmentId, artifactId, actor: 'user' });
    expect(await isApproved(db, artifactId)).toBe(true);
  });
});
