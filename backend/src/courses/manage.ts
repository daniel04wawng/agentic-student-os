import type { SqlClient } from '../db/client.js';

export interface CourseRow {
  id: string;
  name: string;
  code: string | null;
  status: string;
  source_id: string | null;
}

/**
 * List courses. By default hides removed ones (status='archived'); pass
 * `includeRemoved` to see everything. Ordered active-first, then by name.
 */
export async function listCourses(
  db: SqlClient,
  opts: { includeRemoved?: boolean } = {},
): Promise<CourseRow[]> {
  const where = opts.includeRemoved ? '' : `WHERE status <> 'archived'`;
  const { rows } = await db.query<CourseRow>(
    `SELECT id, name, code, status, source_id FROM courses ${where}
     ORDER BY (status = 'archived'), name`,
  );
  return rows;
}

/** Resolve a course by internal id or by its Canvas source id. */
async function resolveCourseId(db: SqlClient, ref: { id?: string; canvasId?: number | string }): Promise<string | null> {
  if (ref.id) return ref.id;
  if (ref.canvasId != null) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM courses WHERE source = 'canvas' AND source_id = $1`,
      [String(ref.canvasId)],
    );
    return rows[0]?.id ?? null;
  }
  return null;
}

/**
 * Remove a course from the working set: mark it `archived`. This is reversible
 * ({@link restoreCourse}) and non-destructive — data stays, but views, prep, and
 * the agenda skip it. Re-ingesting from Canvas will NOT un-remove it, because the
 * course projector preserves `status` on conflict. Returns true if a row changed.
 */
export async function removeCourse(
  db: SqlClient,
  ref: { id?: string; canvasId?: number | string },
): Promise<boolean> {
  const id = await resolveCourseId(db, ref);
  if (!id) return false;
  const { rows } = await db.query<{ id: string }>(
    `UPDATE courses SET status = 'archived' WHERE id = $1 AND status <> 'archived' RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/** Restore a previously removed course back into the active working set. */
export async function restoreCourse(
  db: SqlClient,
  ref: { id?: string; canvasId?: number | string },
): Promise<boolean> {
  const id = await resolveCourseId(db, ref);
  if (!id) return false;
  const { rows } = await db.query<{ id: string }>(
    `UPDATE courses SET status = 'active' WHERE id = $1 AND status = 'archived' RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
