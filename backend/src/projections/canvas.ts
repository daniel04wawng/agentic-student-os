import type { EventEnvelope } from '@student-os/shared';
import { CANVAS_EVENT } from '../canvas/types.js';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';

/**
 * Project normalized Canvas discovery events into the canonical `courses` /
 * `assignments` tables. Canvas is the canonical source for these objects, so
 * canonical fields (name, due date, ...) are updated on conflict, while our own
 * lifecycle `status` is PRESERVED (never clobbered by a re-projection).
 *
 * Upserts key on the partial unique index (source, source_id). These handlers
 * are idempotent; the bus already dedups identical discovery deliveries.
 * Propagating CHANGES from Canvas (new due date, etc.) is reconciliation (PR 26),
 * which emits update-type events with content-based idempotency keys.
 */

function str(v: unknown): string {
  return String(v);
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
/** Drop null/undefined entries so a later event never clobbers stored metadata. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
}

export async function upsertCourseFromEvent(db: SqlClient, event: EventEnvelope): Promise<string> {
  const p = event.payload;
  const metadata = compact({
    canvas_id: p.canvas_id,
    workflow_state: p.workflow_state,
    time_zone: p.time_zone,
  });
  const res = await db.query<{ id: string }>(
    `INSERT INTO courses (name, code, term, source, source_id, metadata)
     VALUES ($1, $2, $3, 'canvas', $4, $5::jsonb)
     ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL
     DO UPDATE SET name = excluded.name,
                   code = excluded.code,
                   term = excluded.term,
                   metadata = courses.metadata || excluded.metadata
     RETURNING id`,
    [str(p.name), strOrNull(p.code), strOrNull(p.term), str(p.canvas_id), JSON.stringify(metadata)],
  );
  return res.rows[0]!.id;
}

export async function upsertAssignmentFromEvent(
  db: SqlClient,
  event: EventEnvelope,
): Promise<string> {
  const p = event.payload;
  const canvasCourseId = str(p.canvas_course_id);

  const course = await db.query<{ id: string }>(
    `SELECT id FROM courses WHERE source = 'canvas' AND source_id = $1`,
    [canvasCourseId],
  );
  if (course.rows.length === 0) {
    throw new Error(`cannot project assignment: course canvas_id=${canvasCourseId} not found`);
  }
  const courseId = course.rows[0]!.id;
  const metadata = compact({ canvas_id: p.canvas_id, canvas_course_id: p.canvas_course_id });

  const res = await db.query<{ id: string }>(
    `INSERT INTO assignments
       (course_id, title, description, due_at, points_possible, source, source_id, source_url, metadata)
     VALUES ($1, $2, $3, $4, $5, 'canvas', $6, $7, $8::jsonb)
     ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL
     DO UPDATE SET title = excluded.title,
                   description = excluded.description,
                   due_at = excluded.due_at,
                   points_possible = excluded.points_possible,
                   source_url = excluded.source_url,
                   metadata = assignments.metadata || excluded.metadata
     -- status is intentionally NOT updated: preserve our lifecycle state.
     RETURNING id`,
    [
      courseId,
      str(p.title),
      strOrNull(p.description),
      strOrNull(p.due_at),
      p.points_possible ?? null,
      str(p.canvas_id),
      strOrNull(p.url),
      JSON.stringify(metadata),
    ],
  );
  return res.rows[0]!.id;
}

/** Register the Canvas projectors as handlers on the event bus. */
export function registerCanvasProjectors(bus: EventBus, db: SqlClient): void {
  bus.on(CANVAS_EVENT.courseDiscovered, (event) => upsertCourseFromEvent(db, event).then(() => {}));
  bus.on(CANVAS_EVENT.assignmentDiscovered, (event) =>
    upsertAssignmentFromEvent(db, event).then(() => {}),
  );
}
