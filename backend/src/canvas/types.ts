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

/** Normalized internal event names emitted from Canvas ingestion. */
export const CANVAS_EVENT = {
  courseDiscovered: 'canvas.course.discovered',
  assignmentDiscovered: 'canvas.assignment.discovered',
} as const;
