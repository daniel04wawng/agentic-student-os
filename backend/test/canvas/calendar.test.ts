import { EventEnvelopeSchema } from '@student-os/shared';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DirectCanvasClient, type CanvasContentClient, type FetchLike } from '../../src/canvas/client.js';
import { ingestCourseCalendar } from '../../src/canvas/ingest.js';
import { calendarEventToSessionEvent, courseToEvent } from '../../src/canvas/normalize.js';
import type { CanvasCalendarEvent } from '../../src/canvas/types.js';
import { EventBus } from '../../src/events/bus.js';
import { registerCanvasProjectors, upsertCourseFromEvent } from '../../src/projections/canvas.js';
import { freshDb, resetDb } from '../db/helpers.js';

const trace = '00000000-0000-0000-0000-000000000000';
const at = '2026-09-07T12:00:00.000Z';

describe('calendarEventToSessionEvent', () => {
  it('produces a valid session-discovered envelope', () => {
    const e = calendarEventToSessionEvent(
      { id: 55, title: 'Global Macro - Lecture 1', start_at: '2026-09-08T18:00:00Z', end_at: '2026-09-08T19:30:00Z' },
      42,
      trace,
      at,
    );
    expect(EventEnvelopeSchema.safeParse(e).success).toBe(true);
    expect(e.name).toBe('canvas.session.discovered');
    expect(e.payload).toMatchObject({ canvas_event_id: 55, canvas_course_id: 42, starts_at: '2026-09-08T18:00:00Z' });
  });
});

describe('DirectCanvasClient.listCalendarEvents', () => {
  it('queries the calendar endpoint with the course context + date window', async () => {
    let seen = '';
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return new Response(JSON.stringify([{ id: 1, title: 'Class', start_at: '2026-09-08T18:00:00Z' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new DirectCanvasClient({ baseUrl: 'https://c', token: 't', fetchImpl });
    const events = await client.listCalendarEvents(42, '2026-09-01', '2026-09-30');
    expect(events).toHaveLength(1);
    expect(seen).toContain('/api/v1/calendar_events');
    expect(seen).toContain('context_codes[]=course_42');
    expect(seen).toContain('start_date=2026-09-01');
  });
});

describe('ingestCourseCalendar -> sessions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetDb(db);
  });

  const events: CanvasCalendarEvent[] = [
    { id: 101, title: 'Lecture 1', start_at: '2026-09-08T18:00:00Z', end_at: '2026-09-08T19:30:00Z' },
    { id: 102, title: 'Lecture 2', start_at: '2026-09-10T18:00:00Z' },
  ];
  const client = { listCalendarEvents: async () => events } as unknown as CanvasContentClient;

  it('populates sessions from the calendar and is idempotent', async () => {
    const bus = new EventBus(db);
    registerCanvasProjectors(bus, db);
    await upsertCourseFromEvent(db, courseToEvent({ id: 42, name: 'Global Macro' }, trace, at));

    const res = await ingestCourseCalendar(client, bus, 42, {
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      now: () => at,
    });
    expect(res.sessions).toBe(2);

    const rows = await db.query<{ n: number; dated: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE starts_at IS NOT NULL)::int AS dated FROM sessions`,
    );
    expect(rows.rows[0]).toMatchObject({ n: 2, dated: 2 });

    await ingestCourseCalendar(client, bus, 42, { startDate: '2026-09-01', endDate: '2026-09-30', now: () => at });
    const after = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sessions`);
    expect(after.rows[0]!.n).toBe(2); // deduped by calendar event id
  });
});
