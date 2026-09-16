import type { SqlClient } from '../db/client.js';
import type { StorageProvider } from '../storage/provider.js';

export interface RegisterRecordingInput {
  clientId: string;
  contentType?: string;
  title?: string | null;
  capturedAt?: string | null;
  durationMs?: number | null;
}

export interface RecordingRow {
  id: string;
  status: string;
  storage_key: string | null;
}

/**
 * Granola-style match: find the class session a recording belongs to by its
 * capture time. Picks the session whose scheduled window contains the capture
 * time (with a grace margin either side), nearest start wins. Returns null when
 * no class is close enough — the recording is simply left unlinked. `graceMin`
 * absorbs starting the recorder a little early or late.
 */
export async function matchSessionForTime(
  db: SqlClient,
  capturedAt: string,
  graceMin = 30,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM sessions
     WHERE starts_at IS NOT NULL
       AND $1::timestamptz >= starts_at - ($2 || ' minutes')::interval
       AND $1::timestamptz <= COALESCE(ends_at, starts_at + interval '180 minutes') + ($2 || ' minutes')::interval
     ORDER BY abs(extract(epoch FROM ($1::timestamptz - starts_at)))
     LIMIT 1`,
    [capturedAt, String(graceMin)],
  );
  return rows[0]?.id ?? null;
}

/**
 * Register a recording. Idempotent on the client-generated id. On first insert
 * it auto-links to the class session matching its capture time (Granola-style)
 * and persists the reported duration.
 */
export async function registerRecording(
  db: SqlClient,
  input: RegisterRecordingInput,
): Promise<RecordingRow> {
  const sessionId = input.capturedAt ? await matchSessionForTime(db, input.capturedAt) : null;
  const inserted = await db.query<RecordingRow>(
    `INSERT INTO recordings (client_id, content_type, title, captured_at, duration_ms, session_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id) DO NOTHING
     RETURNING id, status, storage_key`,
    [
      input.clientId,
      input.contentType ?? 'application/octet-stream',
      input.title ?? null,
      input.capturedAt ?? null,
      input.durationMs ?? null,
      sessionId,
    ],
  );
  if (inserted.rows.length > 0) return inserted.rows[0]!;

  const existing = await db.query<RecordingRow>(
    `SELECT id, status, storage_key FROM recordings WHERE client_id = $1`,
    [input.clientId],
  );
  return existing.rows[0]!;
}

/**
 * Re-point a recording to a different class session (manual override when the
 * automatic time match got it wrong, or to link an unmatched one). Also updates
 * any already-generated lecture notes so they carry the corrected session/course.
 * Passing null unlinks it.
 */
export async function setRecordingSession(
  db: SqlClient,
  recordingId: string,
  sessionId: string | null,
): Promise<boolean> {
  const res = await db.query<{ id: string }>(
    `UPDATE recordings SET session_id = $2 WHERE id = $1 RETURNING id`,
    [recordingId, sessionId],
  );
  await db.query(
    `UPDATE lecture_notes
       SET session_id = $2,
           course_id = (SELECT course_id FROM sessions WHERE id = $2)
     WHERE recording_id = $1`,
    [recordingId, sessionId],
  );
  return res.rows.length > 0;
}

/**
 * Store the audio bytes for a recording. Writes to object storage first, then
 * marks the row stored. Idempotent (overwrites the same key), so a resumable
 * client retry is safe. A storage failure marks the row failed WITHOUT losing
 * it — the device keeps its local copy and can retry.
 */
export async function storeAudio(
  db: SqlClient,
  storage: StorageProvider,
  recordingId: string,
  bytes: Buffer,
): Promise<{ key: string; size: number }> {
  const found = await db.query<{ content_type: string }>(
    `SELECT content_type FROM recordings WHERE id = $1`,
    [recordingId],
  );
  if (found.rows.length === 0) throw new Error(`recording not found: ${recordingId}`);

  const key = `recordings/${recordingId}`;
  try {
    await storage.put(key, bytes, found.rows[0]!.content_type);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(`UPDATE recordings SET status='failed', last_error=$2 WHERE id=$1`, [recordingId, message]);
    throw err;
  }

  await db.query(
    `UPDATE recordings
       SET status='stored', storage_key=$2, byte_size=$3, uploaded_at=now(), last_error=NULL
     WHERE id=$1`,
    [recordingId, key, bytes.length],
  );
  return { key, size: bytes.length };
}

export async function getRecording(db: SqlClient, recordingId: string): Promise<RecordingRow | null> {
  const { rows } = await db.query<RecordingRow>(
    `SELECT id, status, storage_key FROM recordings WHERE id = $1`,
    [recordingId],
  );
  return rows[0] ?? null;
}
