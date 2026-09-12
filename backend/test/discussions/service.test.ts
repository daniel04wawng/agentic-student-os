import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approveArtifact } from '../../src/approval/approval.js';
import type { SqlClient } from '../../src/db/client.js';
import {
  draftDiscussion,
  extractPrepQuestions,
  ingestDiscussions,
  submitDiscussion,
} from '../../src/discussions/service.js';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { freshDb, insertCourse, resetDb } from '../db/helpers.js';

const auth = { baseUrl: 'https://canvas.test', token: 't' };

/** A fake fetch returning one discussion topic (the DP2 shape). */
function discussionsFetch(): typeof fetch {
  return (async () =>
    ({
      ok: true,
      json: async () => [
        {
          id: 555,
          title: 'DP2 - Programming Logic II',
          message:
            '<p>Please answer the class prep questions.</p><ul>' +
            '<li>CP1: Why do we need a conditional statement in programming?</li>' +
            '<li>CP2: Why do we need a loop statement in programming?</li></ul>',
          html_url: 'https://canvas.test/courses/1/discussion_topics/555',
          assignment: { due_at: '2026-09-15T18:00:00Z' },
        },
      ],
    }) as unknown as Response) as unknown as typeof fetch;
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

describe('extractPrepQuestions', () => {
  it('pulls out CP-labeled prep questions', () => {
    const qs = extractPrepQuestions('CP1: Why conditionals? CP2: Why loops? End your post with a declaration');
    expect(qs).toEqual(['Why conditionals?', 'Why loops?']);
  });
});

describe('discussion chain', () => {
  it('ingests a discussion as an assignment and feeds prep', async () => {
    const courseId = await insertCourse(db, 'Programming');
    await db.query(`UPDATE courses SET source='canvas', source_id='1' WHERE id=$1`, [courseId]);
    const n = await ingestDiscussions(db as unknown as SqlClient, auth, 1, courseId, discussionsFetch());
    expect(n).toBe(1);
    const a = await db.query<{ id: string; status: string; type: string }>(
      `SELECT id, status, metadata->>'type' AS type FROM assignments WHERE source_id='discussion:555'`,
    );
    expect(a.rows[0]!.type).toBe('discussion');
    // Prep for the due date carries the CP questions.
    const plan = await db.query(
      `SELECT profile->'session_plans'->'2026-09-15' AS p FROM course_profiles WHERE course_id=$1`,
      [courseId],
    );
    expect((plan.rows[0] as { p: { questions: string[] } }).p.questions.length).toBe(2);
  });

  it('drafts a review-ready text artifact, and refuses to submit until approved', async () => {
    const courseId = await insertCourse(db, 'Programming');
    await db.query(`UPDATE courses SET source='canvas', source_id='1' WHERE id=$1`, [courseId]);
    await ingestDiscussions(db as unknown as SqlClient, auth, 1, courseId, discussionsFetch());
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM assignments WHERE source_id='discussion:555'`);
    const assignmentId = rows[0]!.id;

    const model = new ModelService(
      new FakeModelProvider(() => JSON.stringify({ post: 'CP1: ... CP2: ...\n\nAI declaration: drafted with AI.' })),
    );
    const { artifactId } = await draftDiscussion(db as unknown as SqlClient, model, assignmentId);
    const status = await db.query<{ s: string }>(`SELECT status::text AS s FROM assignments WHERE id=$1`, [assignmentId]);
    expect(status.rows[0]!.s).toBe('review_ready');

    // Submit is REFUSED before approval.
    const refused = await submitDiscussion(db as unknown as SqlClient, auth, assignmentId, { dryRun: true });
    expect(refused.status).toBe('refused');

    // Approve the exact draft, then dry-run submit succeeds.
    await approveArtifact(db as unknown as SqlClient, { assignmentId, artifactId, actor: 'user' });
    const dry = await submitDiscussion(db as unknown as SqlClient, auth, assignmentId, { dryRun: true });
    expect(dry.status).toBe('dry_run');
    if (dry.status === 'dry_run') expect(dry.post).toContain('AI declaration');
  });
});
