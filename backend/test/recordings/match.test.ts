import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlClient } from '../../src/db/client.js';
import {
  matchSessionForTime,
  registerRecording,
  setRecordingSession,
} from '../../src/recordings/service.js';
import { freshDb, insertCourse, resetDb } from '../db/helpers.js';

async function insertSession(
  db: PGlite,
  courseId: string,
  title: string,
  startsAt: string,
  endsAt: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sessions (course_id, title, starts_at, ends_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [courseId, title, startsAt, endsAt],
  );
  return rows[0]!.id;
}

async function sessionOf(db: PGlite, recordingId: string): Promise<string | null> {
  const { rows } = await db.query<{ session_id: string | null }>(
    `SELECT session_id FROM recordings WHERE id = $1`,
    [recordingId],
  );
  return rows[0]!.session_id;
}

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

describe('matchSessionForTime (Granola-style)', () => {
  it('matches a capture time inside the class window', async () => {
    const courseId = await insertCourse(db, 'Strategy');
    const sid = await insertSession(db, courseId, 'Class A', '2026-09-15T14:00:00Z', '2026-09-15T15:30:00Z');
    // Recorder started 5 minutes into class.
    const match = await matchSessionForTime(db as unknown as SqlClient, '2026-09-15T14:05:00Z');
    expect(match).toBe(sid);
  });

  it('returns null when no class is close', async () => {
    const courseId = await insertCourse(db, 'Strategy');
    await insertSession(db, courseId, 'Class A', '2026-09-15T14:00:00Z', '2026-09-15T15:30:00Z');
    const match = await matchSessionForTime(db as unknown as SqlClient, '2026-09-16T09:00:00Z');
    expect(match).toBeNull();
  });

  it('picks the nearest session when two are on the same day', async () => {
    const courseId = await insertCourse(db, 'Strategy');
    await insertSession(db, courseId, 'Morning', '2026-09-15T09:00:00Z', '2026-09-15T10:30:00Z');
    const afternoon = await insertSession(db, courseId, 'Afternoon', '2026-09-15T14:00:00Z', '2026-09-15T15:30:00Z');
    const match = await matchSessionForTime(db as unknown as SqlClient, '2026-09-15T14:02:00Z');
    expect(match).toBe(afternoon);
  });
});

describe('registerRecording auto-linking', () => {
  it('links a new recording to the class matching its capture time and stores duration', async () => {
    const courseId = await insertCourse(db, 'Strategy');
    const sid = await insertSession(db, courseId, 'Class A', '2026-09-15T14:00:00Z', '2026-09-15T15:30:00Z');
    const rec = await registerRecording(db as unknown as SqlClient, {
      clientId: 'c1',
      capturedAt: '2026-09-15T14:03:00Z',
      durationMs: 4200,
    });
    expect(await sessionOf(db, rec.id)).toBe(sid);
    const { rows } = await db.query<{ duration_ms: number }>(`SELECT duration_ms FROM recordings WHERE id=$1`, [rec.id]);
    expect(rows[0]!.duration_ms).toBe(4200);
  });

  it('leaves an unmatched recording unlinked', async () => {
    const rec = await registerRecording(db as unknown as SqlClient, {
      clientId: 'c2',
      capturedAt: '2026-09-15T14:03:00Z',
    });
    expect(await sessionOf(db, rec.id)).toBeNull();
  });
});

describe('setRecordingSession override', () => {
  it('re-points a recording and updates its lecture notes', async () => {
    const courseId = await insertCourse(db, 'Strategy');
    const sid = await insertSession(db, courseId, 'Right class', '2026-09-15T14:00:00Z', '2026-09-15T15:30:00Z');
    const rec = await registerRecording(db as unknown as SqlClient, { clientId: 'c3', capturedAt: '2026-09-20T09:00:00Z' });
    expect(await sessionOf(db, rec.id)).toBeNull();

    // A note already exists for this recording (unmatched).
    const t = await db.query<{ id: string }>(
      `INSERT INTO transcripts (recording_id, text, status) VALUES ($1,'hello','completed') RETURNING id`,
      [rec.id],
    );
    await db.query(
      `INSERT INTO lecture_notes (transcript_id, recording_id) VALUES ($1,$2)`,
      [t.rows[0]!.id, rec.id],
    );

    const ok = await setRecordingSession(db as unknown as SqlClient, rec.id, sid);
    expect(ok).toBe(true);
    expect(await sessionOf(db, rec.id)).toBe(sid);
    const note = await db.query<{ session_id: string | null; course_id: string | null }>(
      `SELECT session_id, course_id FROM lecture_notes WHERE recording_id=$1`,
      [rec.id],
    );
    expect(note.rows[0]!.session_id).toBe(sid);
    expect(note.rows[0]!.course_id).toBe(courseId);
  });
});
