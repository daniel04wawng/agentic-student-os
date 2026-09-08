/**
 * Minimal typed shapes for the subset of the Canvas REST API we read. Canvas is
 * the canonical source for these academic objects; PR 4 is READ-ONLY (no write
 * methods exist on the client).
 */
export interface CanvasUser {
  id: number;
  name: string;
}

export interface CanvasCourse {
  id: number;
  name: string;
  course_code?: string;
  workflow_state?: string;
  term?: { name?: string } | null;
  enrollment_term_id?: number;
  /** IANA time zone of the course; used by the deadline engine (PR 6). */
  time_zone?: string;
  /** Present only when requested with include[]=syllabus_body. */
  syllabus_body?: string | null;
}

export interface CanvasAssignment {
  id: number;
  course_id: number;
  name: string;
  description?: string | null;
  due_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
}

export interface CanvasModule {
  id: number;
  name: string;
  position?: number;
  items_count?: number;
}

export interface CanvasDiscussion {
  id: number;
  title: string;
  posted_at?: string | null;
}

export interface CanvasCalendarEvent {
  id: number;
  title: string;
  start_at?: string | null;
  end_at?: string | null;
  context_code?: string;
}

export interface CanvasFile {
  id: number;
  display_name: string;
  url: string;
  'content-type'?: string;
  content_type?: string;
  size?: number;
}

/** Normalized internal event names emitted from Canvas ingestion. */
export const CANVAS_EVENT = {
  courseDiscovered: 'canvas.course.discovered',
  assignmentDiscovered: 'canvas.assignment.discovered',
  sessionDiscovered: 'canvas.session.discovered',
} as const;
