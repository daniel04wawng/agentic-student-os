import { randomUUID } from 'node:crypto';
import type { EventBus } from '../events/bus.js';
import type { CanvasClient } from './client.js';
import { assignmentToEvent, courseToEvent } from './normalize.js';

export interface IngestOptions {
  /** Correlate the whole ingestion run. Defaults to a fresh uuid. */
  traceId?: string;
  /** Injectable clock for the events' occurred_at. */
  now?: () => string;
}

export interface IngestResult {
  traceId: string;
  courses: number;
  assignments: number;
  duplicates: number;
}

/**
 * Read active courses + their assignments from Canvas and publish normalized
 * events onto the bus. Idempotent by construction: re-running dedups on each
 * object's idempotency key, so duplicate Canvas objects never create duplicate
 * internal records. READ-ONLY: nothing is written back to Canvas.
 */
export async function ingestCanvas(
  client: CanvasClient,
  bus: EventBus,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const traceId = opts.traceId ?? randomUUID();
  const now = opts.now ?? (() => new Date().toISOString());

  let courseCount = 0;
  let assignmentCount = 0;
  let duplicates = 0;

  const courses = await client.listActiveCourses();
  for (const course of courses) {
    const res = await bus.publish(courseToEvent(course, traceId, now()));
    courseCount += 1;
    if (res.duplicate) duplicates += 1;

    const assignments = await client.listAssignments(course.id);
    for (const assignment of assignments) {
      const aRes = await bus.publish(assignmentToEvent(assignment, traceId, now()));
      assignmentCount += 1;
      if (aRes.duplicate) duplicates += 1;
    }
  }

  return { traceId, courses: courseCount, assignments: assignmentCount, duplicates };
}
