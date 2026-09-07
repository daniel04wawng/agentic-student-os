import { deriveIdempotencyKey } from '@student-os/shared';
import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import { TRANSCRIPTION_COMPLETED } from './service.js';
import type { TranscriptUtterance, TranscriptWord } from './provider.js';

export const TRANSCRIPT_PROCESSED = 'transcript.processed';

/** Default window used when a session has no explicit end time. */
const DEFAULT_SESSION_HOURS = 3;

export interface TranscriptExtraction {
  word_count: number;
  utterance_count: number;
  speaker_count: number;
  speakers: number[];
  duration_s: number | null;
}

/**
 * Deterministic structured extraction from a transcript. No LLM: speaker/word/
 * utterance counts and the set of speakers. Richer semantic extraction can layer
 * on once the model layer (PR 12) exists.
 */
export function extractStructure(
  words: TranscriptWord[],
  utterances: TranscriptUtterance[],
  durationS: number | null,
): TranscriptExtraction {
  const speakers = new Set<number>();
  for (const w of words) if (typeof w.speaker === 'number') speakers.add(w.speaker);
  for (const u of utterances) if (typeof u.speaker === 'number') speakers.add(u.speaker);
  return {
    word_count: words.length,
    utterance_count: utterances.length,
    speaker_count: speakers.size,
    speakers: [...speakers].sort((a, b) => a - b),
    duration_s: durationS,
  };
}

export type SessionResolution =
  | { matched: true; sessionId: string; reason: 'schedule_time_match' }
  | { matched: false; reason: 'no_timestamp' | 'no_match' | 'ambiguous' };

/**
 * Resolve which scheduled session a recording belongs to, by matching its
 * capture time against session time windows. Conservative: only a UNIQUE time
 * match resolves; zero or multiple matches are left unresolved (stored safely,
 * never guessed).
 */
export async function resolveSession(
  db: SqlClient,
  capturedAt: string | null,
): Promise<SessionResolution> {
  if (!capturedAt) return { matched: false, reason: 'no_timestamp' };
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM sessions
     WHERE starts_at IS NOT NULL
       AND starts_at <= $1
       AND $1 <= COALESCE(ends_at, starts_at + ($2 || ' hours')::interval)`,
    [capturedAt, String(DEFAULT_SESSION_HOURS)],
  );
  if (rows.length === 0) return { matched: false, reason: 'no_match' };
  if (rows.length > 1) return { matched: false, reason: 'ambiguous' };
  return { matched: true, sessionId: rows[0]!.id, reason: 'schedule_time_match' };
}

/**
 * Process a completed transcript: compute a deterministic extraction, resolve
 * (or safely leave unresolved) its session, and emit `transcript.processed`.
 * Idempotent via the event idempotency key.
 */
export async function processTranscript(
  db: SqlClient,
  bus: EventBus,
  transcriptId: string,
): Promise<void> {
  const { rows } = await db.query<{
    words: TranscriptWord[];
    utterances: TranscriptUtterance[];
    duration_s: number | null;
    recording_id: string;
    captured_at: string | null;
  }>(
    `SELECT t.words, t.utterances, t.duration_s, t.recording_id,
            to_char(r.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at
     FROM transcripts t JOIN recordings r ON r.id = t.recording_id
     WHERE t.id = $1`,
    [transcriptId],
  );
  if (rows.length === 0) throw new Error(`transcript not found: ${transcriptId}`);
  const row = rows[0]!;

  const extraction = extractStructure(row.words ?? [], row.utterances ?? [], row.duration_s);
  await db.query(
    `UPDATE transcripts SET metadata = metadata || jsonb_build_object('extraction', $2::jsonb) WHERE id = $1`,
    [transcriptId, JSON.stringify(extraction)],
  );

  const resolution = await resolveSession(db, row.captured_at);
  if (resolution.matched) {
    await db.query(
      `UPDATE recordings
         SET session_id = $2,
             metadata = metadata || jsonb_build_object('session_resolution', $3::text)
       WHERE id = $1`,
      [row.recording_id, resolution.sessionId, resolution.reason],
    );
  } else {
    // Unresolved relationship is recorded, not dropped.
    await db.query(
      `UPDATE recordings SET metadata = metadata || jsonb_build_object('session_resolution', $2::text) WHERE id = $1`,
      [row.recording_id, resolution.reason],
    );
  }

  await bus.publish({
    name: TRANSCRIPT_PROCESSED,
    occurred_at: new Date().toISOString(),
    idempotency_key: deriveIdempotencyKey(['transcript', 'processed', transcriptId]),
    trace_id: randomUUID(),
    source: 'system',
    subject_type: 'transcript',
    subject_id: transcriptId,
    payload: {
      transcript_id: transcriptId,
      recording_id: row.recording_id,
      session_id: resolution.matched ? resolution.sessionId : null,
      session_resolution: resolution.reason,
      extraction,
    },
  });
}

/** Auto-process a transcript as soon as it completes. */
export function registerTranscriptProcessor(bus: EventBus, db: SqlClient): void {
  bus.on(TRANSCRIPTION_COMPLETED, (event) => {
    const transcriptId = event.payload.transcript_id;
    if (typeof transcriptId === 'string') {
      return processTranscript(db, bus, transcriptId);
    }
  });
}
