import { deriveIdempotencyKey, type EventEnvelope } from '@student-os/shared';
import type { CanvasAssignment, CanvasCalendarEvent, CanvasCourse } from './types.js';
import { CANVAS_EVENT } from './types.js';

/**
 * Pure mappers from Canvas objects to normalized internal event envelopes.
 *
 * The idempotency key is derived only from stable identity (provider + kind +
 * external id), NOT from the ingestion time, so re-ingesting the same Canvas
 * object dedups instead of creating a duplicate. `occurred_at` carries the
 * ingestion instant.
 */
export function courseToEvent(
  course: CanvasCourse,
  traceId: string,
  occurredAt: string,
): EventEnvelope {
  return {
    name: CANVAS_EVENT.courseDiscovered,
    occurred_at: occurredAt,
    idempotency_key: deriveIdempotencyKey(['canvas', 'course', String(course.id)]),
    trace_id: traceId,
    source: 'canvas',
    subject_type: 'course',
    payload: {
      canvas_id: course.id,
      name: course.name,
      code: course.course_code ?? null,
      term: course.term?.name ?? null,
      workflow_state: course.workflow_state ?? null,
      time_zone: course.time_zone ?? null,
    },
  };
}

export function calendarEventToSessionEvent(
  event: CanvasCalendarEvent,
  canvasCourseId: number,
  traceId: string,
  occurredAt: string,
): EventEnvelope {
  return {
    name: CANVAS_EVENT.sessionDiscovered,
    occurred_at: occurredAt,
    idempotency_key: deriveIdempotencyKey(['canvas', 'session', String(event.id)]),
    trace_id: traceId,
    source: 'canvas',
    subject_type: 'session',
    payload: {
      canvas_event_id: event.id,
      canvas_course_id: canvasCourseId,
      title: event.title,
      starts_at: event.start_at ?? null,
      ends_at: event.end_at ?? null,
    },
  };
}

export function assignmentToEvent(
  assignment: CanvasAssignment,
  traceId: string,
  occurredAt: string,
): EventEnvelope {
  return {
    name: CANVAS_EVENT.assignmentDiscovered,
    occurred_at: occurredAt,
    idempotency_key: deriveIdempotencyKey(['canvas', 'assignment', String(assignment.id)]),
    trace_id: traceId,
    source: 'canvas',
    subject_type: 'assignment',
    payload: {
      canvas_id: assignment.id,
      canvas_course_id: assignment.course_id,
      title: assignment.name,
      description: assignment.description ?? null,
      due_at: assignment.due_at ?? null,
      points_possible: assignment.points_possible ?? null,
      url: assignment.html_url ?? null,
    },
  };
}
