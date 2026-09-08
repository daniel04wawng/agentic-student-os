import { deriveIdempotencyKey } from '@student-os/shared';
import { randomUUID } from 'node:crypto';
import { getPermissionPolicy, isApproved } from '../approval/approval.js';
import type { CanvasSubmitClient } from '../canvas/submit.js';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import type { GoogleDocsClient } from '../google/client.js';

export const ASSIGNMENT_SUBMITTED = 'assignment.submitted';

/** How to submit the artifact to Canvas. */
export type SubmissionType = 'link' | 'text' | 'pdf';

export interface SubmitOptions {
  /** Defaults to 'link' (submit the Doc URL). 'text'/'pdf' need a Google client. */
  submissionType?: SubmissionType;
  google?: GoogleDocsClient;
}

export type SubmitOutcome =
  | { status: 'verified'; canvasSubmissionId: string }
  | { status: 'failed'; reason: string }
  | { status: 'refused'; reason: string }
  | { status: 'already_submitted' };

interface Deps {
  bus: EventBus;
}

/** The artifact that is cleared to submit: a review_ready artifact for the assignment. */
async function submittableArtifact(
  db: SqlClient,
  assignmentId: string,
): Promise<{ artifactId: string; uri: string | null; docId: string | null } | null> {
  const { rows } = await db.query<{ id: string; uri: string | null; source_id: string | null }>(
    `SELECT a.id, a.uri, a.source_id FROM artifacts a JOIN deliverables d ON d.id = a.deliverable_id
     WHERE d.assignment_id = $1 AND a.status IN ('review_ready','approved')
     ORDER BY a.updated_at DESC LIMIT 1`,
    [assignmentId],
  );
  return rows[0] ? { artifactId: rows[0].id, uri: rows[0].uri, docId: rows[0].source_id } : null;
}

/**
 * Submit an assignment to Canvas. EXTRA CARE:
 *  - No submission unless the permission policy permits it. Under require_review,
 *    an exact-version approval MUST exist for the artifact.
 *  - Idempotent: a submission already submitted/verified is never re-sent.
 *  - Verify-after-write: a successful submit call is NOT proof; we read the
 *    submission back from Canvas and only then mark it verified.
 */
export async function submitAssignment(
  db: SqlClient,
  canvas: CanvasSubmitClient,
  deps: Deps,
  assignmentId: string,
  opts: SubmitOptions = {},
): Promise<SubmitOutcome> {
  // Idempotent create of the submission record.
  await db.query(
    `INSERT INTO submissions (assignment_id, status) VALUES ($1, 'pending')
     ON CONFLICT (assignment_id) DO NOTHING`,
    [assignmentId],
  );
  const cur = await db.query<{ status: string }>(
    `SELECT status FROM submissions WHERE assignment_id = $1`,
    [assignmentId],
  );
  if (['submitted', 'verified'].includes(cur.rows[0]!.status)) {
    return { status: 'already_submitted' };
  }

  const artifact = await submittableArtifact(db, assignmentId);
  if (!artifact) return refuse(db, assignmentId, 'no_submittable_artifact');

  // Permission gate.
  const policy = await getPermissionPolicy(db, assignmentId);
  if (policy === 'require_review' && !(await isApproved(db, artifact.artifactId))) {
    return refuse(db, assignmentId, 'not_approved');
  }

  const meta = await db.query<{ canvas_course_id: string | null; canvas_assignment_id: string | null }>(
    `SELECT c.source_id AS canvas_course_id, a.source_id AS canvas_assignment_id
     FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = $1`,
    [assignmentId],
  );
  const canvasCourseId = meta.rows[0]?.canvas_course_id ?? '';
  const canvasAssignmentId = meta.rows[0]?.canvas_assignment_id ?? '';

  await setStatus(db, assignmentId, 'submitting', { artifactId: artifact.artifactId });

  const submissionType = opts.submissionType ?? 'link';
  const args = { canvasCourseId, canvasAssignmentId, artifactUri: artifact.uri, text: '' };

  let canvasSubmissionId: string;
  try {
    if (submissionType === 'pdf') {
      if (!opts.google || !artifact.docId) return refuse(db, assignmentId, 'pdf_needs_google_doc');
      const bytes = await opts.google.exportPdf(artifact.docId);
      const res = await canvas.submitFile(args, {
        bytes,
        filename: `assignment-${assignmentId}.pdf`,
        contentType: 'application/pdf',
      });
      canvasSubmissionId = res.canvasSubmissionId;
    } else if (submissionType === 'text') {
      if (!opts.google || !artifact.docId) return refuse(db, assignmentId, 'text_needs_google_doc');
      const text = await opts.google.getContent(artifact.docId);
      const res = await canvas.submit({ ...args, text });
      canvasSubmissionId = res.canvasSubmissionId;
    } else {
      const res = await canvas.submit(args);
      canvasSubmissionId = res.canvasSubmissionId;
    }
  } catch (err) {
    return fail(db, assignmentId, err instanceof Error ? err.message : String(err));
  }
  await db.query(
    `UPDATE submissions SET status='submitted', canvas_submission_id=$2, submitted_at=now(),
       attempts = attempts + 1 WHERE assignment_id=$1`,
    [assignmentId, canvasSubmissionId],
  );

  // Verify-after-write: the submit succeeding is not proof.
  const verified = await canvas.getSubmission(canvasCourseId, canvasAssignmentId);
  if (!verified) {
    return fail(db, assignmentId, 'verification_failed');
  }

  await db.query(
    `UPDATE submissions SET status='verified', verified=true, verified_at=now(), last_error=NULL
     WHERE assignment_id=$1`,
    [assignmentId],
  );
  await db.query(`UPDATE assignments SET status='submitted' WHERE id=$1`, [assignmentId]);

  await deps.bus.publish({
    name: ASSIGNMENT_SUBMITTED,
    occurred_at: new Date().toISOString(),
    idempotency_key: deriveIdempotencyKey(['assignment', 'submitted', assignmentId]),
    trace_id: randomUUID(),
    source: 'canvas',
    subject_type: 'assignment',
    subject_id: assignmentId,
    payload: { assignment_id: assignmentId, canvas_submission_id: canvasSubmissionId },
  });

  return { status: 'verified', canvasSubmissionId };
}

async function setStatus(
  db: SqlClient,
  assignmentId: string,
  status: string,
  extra: { artifactId?: string } = {},
): Promise<void> {
  await db.query(
    `UPDATE submissions SET status=$2, artifact_id=COALESCE($3, artifact_id) WHERE assignment_id=$1`,
    [assignmentId, status, extra.artifactId ?? null],
  );
}

async function refuse(db: SqlClient, assignmentId: string, reason: string): Promise<SubmitOutcome> {
  await db.query(`UPDATE submissions SET status='pending', last_error=$2 WHERE assignment_id=$1`, [
    assignmentId,
    reason,
  ]);
  return { status: 'refused', reason };
}

async function fail(db: SqlClient, assignmentId: string, reason: string): Promise<SubmitOutcome> {
  await db.query(
    `UPDATE submissions SET status='failed', last_error=$2, attempts = attempts + 1 WHERE assignment_id=$1`,
    [assignmentId, reason],
  );
  return { status: 'failed', reason };
}
