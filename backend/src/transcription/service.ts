import { deriveIdempotencyKey } from '@student-os/shared';
import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import type { StorageProvider } from '../storage/provider.js';
import type { TranscriptionProvider } from './provider.js';

export const TRANSCRIPTION_COMPLETED = 'transcription.completed';

export interface TranscriptRow {
  id: string;
  status: string;
}

/** Create a transcript row for a recording. Idempotent (one per recording). */
export async function requestTranscription(
  db: SqlClient,
  recordingId: string,
): Promise<TranscriptRow> {
  const inserted = await db.query<TranscriptRow>(
    `INSERT INTO transcripts (recording_id) VALUES ($1)
     ON CONFLICT (recording_id) DO NOTHING
     RETURNING id, status`,
    [recordingId],
  );
  if (inserted.rows.length > 0) return inserted.rows[0]!;
  const existing = await db.query<TranscriptRow>(
    `SELECT id, status FROM transcripts WHERE recording_id = $1`,
    [recordingId],
  );
  return existing.rows[0]!;
}

/**
 * Run transcription for a transcript row. Fetches the stored audio, calls the
 * provider, and on success stores the diarized result (word timestamps + speaker
 * labels) and emits `transcription.completed`. On failure the transcript is
 * marked failed (attempts++/last_error) and the AUDIO IS UNTOUCHED, so it can be
 * retried without any data loss.
 */
export async function runTranscription(
  db: SqlClient,
  storage: StorageProvider,
  provider: TranscriptionProvider,
  bus: EventBus,
  transcriptId: string,
): Promise<{ status: string }> {
  const found = await db.query<{
    recording_id: string;
    storage_key: string | null;
    content_type: string;
  }>(
    `SELECT t.recording_id, r.storage_key, r.content_type
     FROM transcripts t JOIN recordings r ON r.id = t.recording_id
     WHERE t.id = $1`,
    [transcriptId],
  );
  if (found.rows.length === 0) throw new Error(`transcript not found: ${transcriptId}`);
  const { recording_id, storage_key, content_type } = found.rows[0]!;
  if (!storage_key) throw new Error(`recording audio not stored for transcript ${transcriptId}`);

  await db.query(`UPDATE transcripts SET status='processing' WHERE id=$1`, [transcriptId]);

  let result;
  try {
    const audio = await storage.get(storage_key);
    result = await provider.transcribe(audio, content_type);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `UPDATE transcripts SET status='failed', attempts = attempts + 1, last_error = $2 WHERE id = $1`,
      [transcriptId, message],
    );
    // Audio blob is intentionally left as-is; nothing is deleted.
    throw err;
  }

  await db.query(
    `UPDATE transcripts
       SET status='completed', text=$2, words=$3::jsonb, utterances=$4::jsonb,
           language=$5, duration_s=$6, request_id=$7, completed_at=now(), last_error=NULL
     WHERE id=$1`,
    [
      transcriptId,
      result.text,
      JSON.stringify(result.words),
      JSON.stringify(result.utterances),
      result.language ?? null,
      result.durationS ?? null,
      result.requestId ?? null,
    ],
  );

  await bus.publish({
    name: TRANSCRIPTION_COMPLETED,
    occurred_at: new Date().toISOString(),
    idempotency_key: deriveIdempotencyKey(['transcription', 'completed', transcriptId]),
    trace_id: randomUUID(),
    source: 'deepgram',
    subject_type: 'transcript',
    subject_id: transcriptId,
    payload: {
      transcript_id: transcriptId,
      recording_id,
      language: result.language ?? null,
      duration_s: result.durationS ?? null,
    },
  });

  return { status: 'completed' };
}
