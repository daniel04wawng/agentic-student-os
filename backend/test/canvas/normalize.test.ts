import { EventEnvelopeSchema } from '@student-os/shared';
import { describe, expect, it } from 'vitest';
import { assignmentToEvent, courseToEvent } from '../../src/canvas/normalize.js';

const traceId = '00000000-0000-0000-0000-000000000000';
const at = '2026-09-07T12:00:00.000Z';

describe('courseToEvent', () => {
  it('produces a valid envelope with canvas provenance and a stable key', () => {
    const e1 = courseToEvent({ id: 42, name: 'CS101', course_code: 'CS-101' }, traceId, at);
    expect(EventEnvelopeSchema.safeParse(e1).success).toBe(true);
    expect(e1.source).toBe('canvas');
    expect(e1.name).toBe('canvas.course.discovered');
    // Same course at a different time -> same idempotency key (dedup).
    const e2 = courseToEvent({ id: 42, name: 'CS101' }, traceId, '2027-01-01T00:00:00.000Z');
    expect(e2.idempotency_key).toBe(e1.idempotency_key);
  });
});

describe('assignmentToEvent', () => {
  it('produces a valid envelope carrying the due date in the payload', () => {
    const e = assignmentToEvent(
      { id: 7, course_id: 42, name: 'HW1', due_at: '2026-05-01T03:59:00Z', points_possible: 10 },
      traceId,
      at,
    );
    expect(EventEnvelopeSchema.safeParse(e).success).toBe(true);
    expect(e.payload).toMatchObject({ canvas_id: 7, title: 'HW1', due_at: '2026-05-01T03:59:00Z' });
    expect(e.idempotency_key).toBe(assignmentToEvent({ id: 7, course_id: 42, name: 'x' }, traceId, at).idempotency_key);
  });
});
