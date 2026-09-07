import type { SqlClient } from '../db/client.js';
import type { TimezoneResolution } from './engine.js';

export interface ReconcileResult {
  assignmentId: string;
  resolution: TimezoneResolution | 'no_deadline';
  timezone: string | null;
}

/**
 * Reconcile an assignment's deadline source timezone. Canvas gives an absolute
 * instant but not always an explicit per-assignment tz; when it is missing we
 * fall back to the course timezone (captured during ingestion) and record the
 * resolution in metadata as provenance. Idempotent: once set, the source tz is
 * treated as explicit and left untouched.
 */
export async function reconcileAssignmentTimezone(
  db: SqlClient,
  assignmentId: string,
): Promise<ReconcileResult> {
  const { rows } = await db.query<{
    due_at: string | null;
    due_source_timezone: string | null;
    course_tz: string | null;
  }>(
    `SELECT a.due_at, a.due_source_timezone, c.metadata->>'time_zone' AS course_tz
     FROM assignments a JOIN courses c ON c.id = a.course_id
     WHERE a.id = $1`,
    [assignmentId],
  );
  if (rows.length === 0) throw new Error(`assignment not found: ${assignmentId}`);
  const row = rows[0]!;

  if (row.due_at == null) {
    return { assignmentId, resolution: 'no_deadline', timezone: row.due_source_timezone };
  }
  if (row.due_source_timezone) {
    return { assignmentId, resolution: 'explicit', timezone: row.due_source_timezone };
  }
  if (row.course_tz) {
    await db.query(
      `UPDATE assignments
         SET due_source_timezone = $2,
             metadata = metadata || jsonb_build_object('tz_resolution', 'course_fallback')
       WHERE id = $1`,
      [assignmentId, row.course_tz],
    );
    return { assignmentId, resolution: 'course_fallback', timezone: row.course_tz };
  }
  return { assignmentId, resolution: 'unknown', timezone: null };
}

/** Reconcile every assignment that has a deadline but no source timezone yet. */
export async function reconcilePendingDeadlines(
  db: SqlClient,
): Promise<{ reconciled: number; unresolved: number }> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM assignments WHERE due_at IS NOT NULL AND due_source_timezone IS NULL`,
  );
  let reconciled = 0;
  let unresolved = 0;
  for (const { id } of rows) {
    const res = await reconcileAssignmentTimezone(db, id);
    if (res.resolution === 'course_fallback') reconciled += 1;
    else if (res.resolution === 'unknown') unresolved += 1;
  }
  return { reconciled, unresolved };
}
