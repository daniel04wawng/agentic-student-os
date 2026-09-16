import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approveArtifact, isApproved } from '../../src/approval/approval.js';
import type { SqlClient } from '../../src/db/client.js';
import {
  draftDiscussion,
  ingestDiscussions,
  submitDiscussion,
  updateDiscussionDraft,
} from '../../src/discussions/service.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { getAssignmentDraft } from '../../src/views/queries.js';
import { freshDb, insertCourse, resetDb } from '../db/helpers.js';

const auth = { baseUrl: 'https://canvas.test', token: 't' };

function discussionsFetch(): typeof fetch {
  return (async () =>
    ({
      ok: true,
      json: async () => [
        {
          id: 555,
          title: 'DP2',
          message: '<p>Answer the prep.</p><ul><li>CP1: Why conditionals?</li></ul>',
          html_url: 'https://canvas.test/courses/1/discussion_topics/555',
          assignment: { due_at: '2026-09-15T18:00:00Z' },
        },
      ],
    }) as unknown as Response) as unknown as typeof fetch;
}

async function setupDraft(db: PGlite): Promise<{ assignmentId: string; artifactId: string }> {
  const courseId = await insertCourse(db, 'Programming');
  await db.query(`UPDATE courses SET source='canvas', source_id='1' WHERE id=$1`, [courseId]);
  await ingestDiscussions(db as unknown as SqlClient, auth, 1, courseId, discussionsFetch());
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM assignments WHERE source_id='discussion:555'`);
  const assignmentId = rows[0]!.id;
  const model = new ModelService(new FakeModelProvider(() => JSON.stringify({ post: 'ORIGINAL DRAFT' })));
  const { artifactId } = await draftDiscussion(db as unknown as SqlClient, model, assignmentId);
  return { assignmentId, artifactId };
}

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

describe('updateDiscussionDraft', () => {
  it('saves edited text and reflects it in the draft view', async () => {
    const { assignmentId } = await setupDraft(db);
    const res = await updateDiscussionDraft(db as unknown as SqlClient, assignmentId, 'EDITED BY STUDENT');
    expect(res).not.toBeNull();
    const draft = await getAssignmentDraft(db as unknown as SqlClient, assignmentId);
    expect(draft?.draft_text).toBe('EDITED BY STUDENT');
  });

  it('editing an approved draft invalidates the approval, blocking submit until re-approval', async () => {
    const { assignmentId, artifactId } = await setupDraft(db);

    // Approve the original, confirm it would submit.
    await approveArtifact(db as unknown as SqlClient, { assignmentId, artifactId, actor: 'user' });
    expect(await isApproved(db as unknown as SqlClient, artifactId)).toBe(true);

    // Edit the text: approval must drop.
    await updateDiscussionDraft(db as unknown as SqlClient, assignmentId, 'DIFFERENT ANSWER');
    expect(await isApproved(db as unknown as SqlClient, artifactId)).toBe(false);
    const refused = await submitDiscussion(db as unknown as SqlClient, auth, assignmentId, { dryRun: true });
    expect(refused.status).toBe('refused');

    // Re-approve the edited version -> submit posts the EDITED text.
    await approveArtifact(db as unknown as SqlClient, { assignmentId, artifactId, actor: 'user' });
    const dry = await submitDiscussion(db as unknown as SqlClient, auth, assignmentId, { dryRun: true });
    expect(dry.status).toBe('dry_run');
    if (dry.status === 'dry_run') expect(dry.post).toBe('DIFFERENT ANSWER');
  });

  it('returns null when there is no draft to edit', async () => {
    const courseId = await insertCourse(db, 'Empty');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO assignments (course_id, title, status) VALUES ($1,'x','not_started') RETURNING id`,
      [courseId],
    );
    const res = await updateDiscussionDraft(db as unknown as SqlClient, rows[0]!.id, 'text');
    expect(res).toBeNull();
  });
});
