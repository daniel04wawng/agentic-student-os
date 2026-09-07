import { randomUUID } from 'node:crypto';
import type { CanvasContentClient } from '../canvas/client.js';
import { assignmentToEvent, courseToEvent } from '../canvas/normalize.js';
import type { CanvasDiscussion, CanvasModule } from '../canvas/types.js';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import { buildCourseProfile, buildPlanningSummary } from './profile.js';

export interface OnboardOptions {
  traceId?: string;
  now?: () => string;
}

export interface OnboardResult {
  courseId: string;
  assignments: number;
  modules: number;
  announcements: number;
  discussions: number;
}

/** Best-effort content read: not all courses expose modules/announcements. */
async function safe<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

/**
 * Onboard a single course: ingest its canonical objects (course + assignments)
 * through the bus so projectors populate the tables, read ancillary context
 * (syllabus/modules/announcements/discussions) best-effort, and write a derived
 * CourseProfile + deterministic planning summary. Idempotent: re-running dedups
 * the canonical events and upserts the profile.
 *
 * Requires the Canvas projectors to be registered on `bus` (so the course row
 * exists after publishing) — see registerCanvasProjectors.
 */
export async function onboardCourse(
  client: CanvasContentClient,
  bus: EventBus,
  db: SqlClient,
  canvasCourseId: number,
  opts: OnboardOptions = {},
): Promise<OnboardResult> {
  const traceId = opts.traceId ?? randomUUID();
  const now = opts.now ?? (() => new Date().toISOString());

  const course = await client.getCourse(canvasCourseId);
  await bus.publish(courseToEvent(course, traceId, now()));

  const assignments = await client.listAssignments(canvasCourseId);
  for (const assignment of assignments) {
    await bus.publish(assignmentToEvent(assignment, traceId, now()));
  }

  const modules: CanvasModule[] = await safe(() => client.listModules(canvasCourseId));
  const announcements: CanvasDiscussion[] = await safe(() => client.listAnnouncements(canvasCourseId));
  const discussions: CanvasDiscussion[] = await safe(() => client.listDiscussions(canvasCourseId));

  const resolved = await db.query<{ id: string }>(
    `SELECT id FROM courses WHERE source = 'canvas' AND source_id = $1`,
    [String(canvasCourseId)],
  );
  if (resolved.rows.length === 0) {
    throw new Error(`onboarding: course ${canvasCourseId} was not projected (are projectors registered?)`);
  }
  const courseId = resolved.rows[0]!.id;

  const profile = buildCourseProfile({ course, assignments, modules, announcements, discussions });
  const planning = buildPlanningSummary({ assignments, now: now() });

  await db.query(
    `INSERT INTO course_profiles (course_id, profile, planning_summary, generated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, now())
     ON CONFLICT (course_id) DO UPDATE
       SET profile = excluded.profile,
           planning_summary = excluded.planning_summary,
           generated_at = now()`,
    [courseId, JSON.stringify(profile), JSON.stringify(planning)],
  );

  return {
    courseId,
    assignments: assignments.length,
    modules: modules.length,
    announcements: announcements.length,
    discussions: discussions.length,
  };
}
