import { deriveIdempotencyKey } from '@student-os/shared';
import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';

export const COURSE_ARCHIVED = 'course.archived';

/** Assignments not yet in a terminal state block archival unless forced. */
export async function remainingDeliverables(db: SqlClient, courseId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM assignments
     WHERE course_id = $1 AND status NOT IN ('submitted','archived')`,
    [courseId],
  );
  return rows[0]!.n;
}

/** A course is at end-state when nothing remains to be delivered. */
export async function detectCourseEndState(db: SqlClient, courseId: string): Promise<boolean> {
  return (await remainingDeliverables(db, courseId)) === 0;
}

export type ArchiveResult =
  | { archived: true }
  | { archived: false; reason: 'remaining_deliverables'; remaining: number };

/**
 * Archive a course: refuse if deliverables remain (unless forced), then mark it
 * archived, PAUSE proactive workflows for it (control_state), and archive its
 * completed assignments. Searchable memory (transcripts / chunks / summaries) is
 * intentionally PRESERVED — archival stops proactive work, it does not erase.
 */
export async function archiveCourse(
  db: SqlClient,
  bus: EventBus,
  courseId: string,
  opts: { force?: boolean } = {},
): Promise<ArchiveResult> {
  const remaining = await remainingDeliverables(db, courseId);
  if (remaining > 0 && !opts.force) {
    return { archived: false, reason: 'remaining_deliverables', remaining };
  }

  await db.query(`UPDATE courses SET status='archived' WHERE id=$1`, [courseId]);
  await db.query(
    `UPDATE assignments SET status='archived' WHERE course_id=$1 AND status='submitted'`,
    [courseId],
  );

  // Stop proactive workflows for the course.
  await db.query(
    `INSERT INTO control_state (scope, scope_id, paused)
     VALUES ('course', $1, true)
     ON CONFLICT (scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET paused = true`,
    [courseId],
  );

  await bus.publish({
    name: COURSE_ARCHIVED,
    occurred_at: new Date().toISOString(),
    idempotency_key: deriveIdempotencyKey(['course', 'archived', courseId]),
    trace_id: randomUUID(),
    source: 'system',
    subject_type: 'course',
    subject_id: courseId,
    payload: { course_id: courseId },
  });

  return { archived: true };
}
