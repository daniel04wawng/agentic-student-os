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
     WHERE a.due_at IS NOT NULL AND a.due_at <= $1 AND c.status <> 'archived'
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

export interface AgendaItem {
  type: 'class' | 'deadline';
  when: string;
  title: string;
  course_name: string;
}

/**
 * A single "when are things" timeline: class meetings (sessions) and assignment
 * deadlines merged and sorted chronologically within a horizon. Removed
 * (archived) courses are excluded. This answers the general calendar question
 * across every course, not just ones that published Canvas calendar events.
 */
export async function getAgenda(
  db: SqlClient,
  q: { now: string; horizonDays?: number; pastDays?: number },
): Promise<AgendaItem[]> {
  const nowMs = Date.parse(q.now);
  const fromBound = new Date(nowMs - (q.pastDays ?? 0) * 86_400_000).toISOString();
  const toBound = new Date(nowMs + (q.horizonDays ?? 14) * 86_400_000).toISOString();

  const classes = await db.query<{ when: unknown; title: string | null; course_name: string }>(
    `SELECT s.starts_at AS when, s.title, c.name AS course_name
     FROM sessions s JOIN courses c ON c.id = s.course_id
     WHERE s.starts_at IS NOT NULL AND s.starts_at BETWEEN $1 AND $2
       AND s.status <> 'canceled' AND c.status <> 'archived'`,
    [fromBound, toBound],
  );
  const deadlines = await db.query<{ when: unknown; title: string; course_name: string }>(
    `SELECT a.due_at AS when, a.title, c.name AS course_name
     FROM assignments a JOIN courses c ON c.id = a.course_id
     WHERE a.due_at IS NOT NULL AND a.due_at BETWEEN $1 AND $2 AND c.status <> 'archived'`,
    [fromBound, toBound],
  );

  const items: AgendaItem[] = [
    ...classes.rows.map((r) => ({
      type: 'class' as const,
      when: toIso(r.when),
      title: r.title ?? r.course_name,
      course_name: r.course_name,
    })),
    ...deadlines.rows.map((r) => ({
      type: 'deadline' as const,
      when: toIso(r.when),
      title: r.title,
      course_name: r.course_name,
    })),
  ];
  return items.sort((a, b) => Date.parse(a.when) - Date.parse(b.when));
}

export interface PrepContent {
  overview: string;
  prior_recap: string;
  key_points: string[];
  questions: string[];
  analysis: string;
  worked_answer: string;
}

export interface PrepView {
  session_id: string;
  course_name: string;
  title: string | null;
  starts_at: string;
  content: PrepContent;
}

/**
 * Upcoming class preps (with full worked content) for sessions in the near
 * future, most imminent first. Includes classes from a few hours ago so a
 * class happening right now still shows. Excludes removed courses.
 */
export async function getUpcomingPreps(
  db: SqlClient,
  q: { now: string; horizonDays?: number },
): Promise<PrepView[]> {
  const fromIso = new Date(Date.parse(q.now) - 12 * 3_600_000).toISOString();
  const toIso = new Date(Date.parse(q.now) + (q.horizonDays ?? 21) * 86_400_000).toISOString();
  const { rows } = await db.query<{
    session_id: string;
    course_name: string;
    title: string | null;
    starts_at: unknown;
    content: PrepContent;
  }>(
    `SELECT p.session_id, c.name AS course_name, s.title,
            to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
            p.content
     FROM class_preps p
     JOIN sessions s ON s.id = p.session_id
     JOIN courses c ON c.id = p.course_id
     WHERE s.starts_at >= $1 AND s.starts_at <= $2 AND c.status <> 'archived'
     ORDER BY s.starts_at ASC`,
    [fromIso, toIso],
  );
  return rows.map((r) => ({
    session_id: r.session_id,
    course_name: r.course_name,
    title: r.title,
    starts_at: String(r.starts_at),
    content: r.content,
  }));
}

export interface LectureContent {
  summary: string;
  key_points: string[];
  topics: string[];
  action_items: string[];
  questions: string[];
}

export interface LectureView {
  transcript_id: string;
  course_name: string | null;
  title: string | null;
  /** Recording capture time (ISO Z), or null if unknown. */
  recorded_at: string | null;
  content: LectureContent;
}

/**
 * Recorded lectures with their AI notes, most recent first. Joined to the
 * resolved session/course when the recording was matched to one.
 */
export async function getLectures(
  db: SqlClient,
  q: { limit?: number } = {},
): Promise<LectureView[]> {
  const { rows } = await db.query<{
    transcript_id: string;
    course_name: string | null;
    title: string | null;
    recorded_at: unknown;
    content: LectureContent;
  }>(
    `SELECT n.transcript_id, c.name AS course_name,
            COALESCE(s.title, r.title) AS title,
            to_char(r.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded_at,
            n.content
     FROM lecture_notes n
     JOIN recordings r ON r.id = n.recording_id
     LEFT JOIN sessions s ON s.id = n.session_id
     LEFT JOIN courses c ON c.id = n.course_id
     WHERE n.status = 'ready'
     ORDER BY r.captured_at DESC NULLS LAST, n.generated_at DESC
     LIMIT $1`,
    [q.limit ?? 100],
  );
  return rows.map((r) => ({
    transcript_id: r.transcript_id,
    course_name: r.course_name,
    title: r.title,
    recorded_at: r.recorded_at ? String(r.recorded_at) : null,
    content: r.content,
  }));
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
