import type { SqlClient } from '../db/client.js';
import { resolveDeadline, wallClockInZone, type ResolvedDeadline } from '../deadline/engine.js';

/** Normalize a Postgres timestamptz (string or Date) to an ISO string. */
function toIso(v: unknown): string {
  return new Date(v as string | number | Date).toISOString();
}

export interface DeadlineView {
  id: string;
  title: string;
  course_name: string;
  past: boolean;
  deadline: ResolvedDeadline;
}

export interface DeadlineQuery {
  now: string;
  currentTimezone: string;
  horizonDays?: number;
}

/**
 * Upcoming (and recently-past) assignment deadlines within a horizon, each
 * resolved into source + current timezone displays.
 */
export async function getDeadlines(db: SqlClient, q: DeadlineQuery): Promise<DeadlineView[]> {
  const nowMs = Date.parse(q.now);
  const horizonIso = new Date(nowMs + (q.horizonDays ?? 30) * 86_400_000).toISOString();

  const { rows } = await db.query<{
    id: string;
    title: string;
    due_at: unknown;
    due_source_timezone: string | null;
    course_name: string;
    course_tz: string | null;
  }>(
    `SELECT a.id, a.title, a.due_at, a.due_source_timezone,
            c.name AS course_name, c.metadata->>'time_zone' AS course_tz
     FROM assignments a JOIN courses c ON c.id = a.course_id
     WHERE a.due_at IS NOT NULL AND a.due_at <= $1
     ORDER BY a.due_at ASC`,
    [horizonIso],
  );

  return rows.map((r) => {
    const dueIso = toIso(r.due_at);
    return {
      id: r.id,
      title: r.title,
      course_name: r.course_name,
      past: Date.parse(dueIso) < nowMs,
      deadline: resolveDeadline({
        dueAt: dueIso,
        sourceTimezone: r.due_source_timezone,
        courseTimezone: r.course_tz,
        currentTimezone: q.currentTimezone,
      }),
    };
  });
}

export interface ReviewView {
  notifications: { id: string; title: string; body: string | null; subject_type: string | null; subject_id: string | null }[];
  assignments: { id: string; title: string }[];
}

/** Items awaiting the user's review. */
export async function getReview(db: SqlClient): Promise<ReviewView> {
  const notifications = await db.query<ReviewView['notifications'][number]>(
    `SELECT id, title, body, subject_type, subject_id
     FROM notifications
     WHERE kind = 'review_ready' AND status <> 'dismissed'
     ORDER BY created_at DESC`,
  );
  const assignments = await db.query<ReviewView['assignments'][number]>(
    `SELECT id, title FROM assignments WHERE status = 'review_ready' ORDER BY updated_at DESC`,
  );
  return { notifications: notifications.rows, assignments: assignments.rows };
}

export interface TodayView {
  date: string;
  deadlines: DeadlineView[];
  notifications: { id: string; kind: string; title: string; body: string | null; status: string }[];
}

/** Today's deadlines (in the current timezone) plus active notifications. */
export async function getToday(
  db: SqlClient,
  q: { now: string; currentTimezone: string },
): Promise<TodayView> {
  const today = wallClockInZone(new Date(q.now), q.currentTimezone).slice(0, 10);
  const all = await getDeadlines(db, { ...q, horizonDays: 2 });
  const deadlines = all.filter((d) => d.deadline.current.wall_clock.slice(0, 10) === today);

  const notifications = await db.query<TodayView['notifications'][number]>(
    `SELECT id, kind, title, body, status
     FROM notifications
     WHERE status <> 'dismissed'
     ORDER BY created_at DESC
     LIMIT 50`,
  );
  return { date: today, deadlines, notifications: notifications.rows };
}
