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

/** Register a recording. Idempotent on the client-generated id. */
export async function registerRecording(
  db: SqlClient,
  input: RegisterRecordingInput,
): Promise<RecordingRow> {
  const inserted = await db.query<RecordingRow>(
    `INSERT INTO recordings (client_id, content_type, title, captured_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id) DO NOTHING
     RETURNING id, status, storage_key`,
    [input.clientId, input.contentType ?? 'application/octet-stream', input.title ?? null, input.capturedAt ?? null],
  );
  if (inserted.rows.length > 0) return inserted.rows[0]!;

  const existing = await db.query<RecordingRow>(
    `SELECT id, status, storage_key FROM recordings WHERE client_id = $1`,
    [input.clientId],
  );
  return existing.rows[0]!;
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
