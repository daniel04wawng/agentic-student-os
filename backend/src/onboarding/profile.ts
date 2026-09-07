import type {
  CanvasAssignment,
  CanvasCourse,
  CanvasDiscussion,
  CanvasModule,
} from '../canvas/types.js';

/**
 * Deterministic onboarding synthesis. No LLM is used here: a course profile and
 * planning summary are pure aggregations of the ingested course state, per the
 * "don't run an LLM where deterministic logic works" invariant. Richer,
 * judgment-based synthesis can layer on later once the model layer exists.
 */

const SYLLABUS_EXCERPT_MAX = 600;

/** Crude HTML-to-text: strip tags, decode a few entities, collapse whitespace. */
export function htmlToExcerpt(html: string | null | undefined, max = SYLLABUS_EXCERPT_MAX): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export interface CourseProfileInput {
  course: CanvasCourse;
  assignments: CanvasAssignment[];
  modules: CanvasModule[];
  announcements: CanvasDiscussion[];
  discussions: CanvasDiscussion[];
}

export function buildCourseProfile(input: CourseProfileInput): Record<string, unknown> {
  const { course, assignments, modules, announcements, discussions } = input;
  return {
    name: course.name,
    code: course.course_code ?? null,
    term: course.term?.name ?? null,
    time_zone: course.time_zone ?? null,
    syllabus_excerpt: htmlToExcerpt(course.syllabus_body),
    counts: {
      assignments: assignments.length,
      modules: modules.length,
      announcements: announcements.length,
      discussions: discussions.length,
    },
    module_titles: modules.slice(0, 20).map((m) => m.name),
    announcement_titles: announcements.slice(0, 10).map((a) => a.title),
  };
}

export interface PlanningSummaryInput {
  assignments: CanvasAssignment[];
  now: string;
}

export function buildPlanningSummary(input: PlanningSummaryInput): Record<string, unknown> {
  const { assignments, now } = input;
  const nowMs = Date.parse(now);

  const dated = assignments.filter((a) => a.due_at != null);
  const upcoming = dated
    .filter((a) => Date.parse(a.due_at as string) >= nowMs)
    .sort((a, b) => Date.parse(a.due_at as string) - Date.parse(b.due_at as string))
    .slice(0, 10)
    .map((a) => ({ title: a.name, due_at: a.due_at }));

  const totalPoints = assignments.reduce((sum, a) => sum + (a.points_possible ?? 0), 0);

  return {
    total_assignments: assignments.length,
    total_points: totalPoints,
    undated_assignments: assignments.length - dated.length,
    past_due: dated.filter((a) => Date.parse(a.due_at as string) < nowMs).length,
    upcoming_deadlines: upcoming,
  };
}
