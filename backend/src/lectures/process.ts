import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import type { ModelService } from '../model/service.js';
import { indexTranscript } from '../retrieval/index-service.js';
import { buildTranscriptSummaries } from '../retrieval/summarize.js';
import type { StorageProvider } from '../storage/provider.js';
import { requestTranscription, runTranscription } from '../transcription/service.js';
import type { TranscriptionProvider } from '../transcription/provider.js';
import { generateLectureNotes } from './notes.js';

/**
 * Generate and store Granola-style notes for one completed transcript. Also
 * (re)builds the transcript's chunks and rolled-up summaries, so the lecture
 * feeds retrieval/search and the next class's prior-recap. Idempotent per
 * transcript (notes upsert; chunk/summary rebuilds replace prior rows).
 */
export async function generateAndStoreNotes(
  db: SqlClient,
  model: ModelService,
  transcriptId: string,
): Promise<void> {
  const { rows } = await db.query<{
    text: string | null;
    recording_id: string;
    session_id: string | null;
    course_id: string | null;
    course_name: string | null;
  }>(
    `SELECT t.text, t.recording_id, r.session_id, s.course_id, c.name AS course_name
     FROM transcripts t
     JOIN recordings r ON r.id = t.recording_id
     LEFT JOIN sessions s ON s.id = r.session_id
     LEFT JOIN courses c ON c.id = s.course_id
     WHERE t.id = $1`,
    [transcriptId],
  );
  if (rows.length === 0) throw new Error(`transcript not found: ${transcriptId}`);
  const row = rows[0]!;

  // Chunk + summarize first so search and prior-recap work even if notes fail.
  await indexTranscript(db, transcriptId);
  await buildTranscriptSummaries(db, transcriptId);

  const notes = await generateLectureNotes(model, row.text ?? '', { courseName: row.course_name });
  await db.query(
    `INSERT INTO lecture_notes (transcript_id, recording_id, session_id, course_id, content, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'ready')
     ON CONFLICT (transcript_id) DO UPDATE
       SET content = excluded.content, status = 'ready', generated_at = now()`,
    [transcriptId, row.recording_id, row.session_id, row.course_id, JSON.stringify(notes)],
  );
  // No standing in-app notification: the Lectures tab surfaces the notes; a
  // pile of undismissable "notes ready" items was just clutter.
}

/**
 * Reliable backstop: transcribe recordings whose audio is stored but that have
 * no transcript yet (or whose transcript failed). The upload route also fires
 * transcription in-process; this catches anything that didn't complete there
 * (e.g. the web container scaled down mid-flight). Only runs when NOT already
 * pending/processing/completed, so it never races or double-charges Deepgram.
 */
export async function transcribeStoredRecordings(
  db: SqlClient,
  storage: StorageProvider,
  provider: TranscriptionProvider,
  bus: EventBus,
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT r.id FROM recordings r
     LEFT JOIN transcripts t ON t.recording_id = r.id
     WHERE r.status = 'stored' AND r.storage_key IS NOT NULL
       AND (t.id IS NULL OR t.status = 'failed')
     ORDER BY r.created_at`,
  );
  let done = 0;
  for (const r of rows) {
    try {
      const t = await requestTranscription(db, r.id);
      await runTranscription(db, storage, provider, bus, t.id);
      done += 1;
    } catch {
      // a single failure must not stop the batch; the row is left retryable
    }
  }
  return done;
}

/**
 * Generate notes for every completed transcript that doesn't have them yet.
 * This is the model-heavy step, so it runs in a scheduled tick (which runs to
 * completion) rather than fire-and-forget on the scale-to-zero web endpoint.
 */
export async function processPendingLectureNotes(
  db: SqlClient,
  model: ModelService,
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.id FROM transcripts t
     LEFT JOIN lecture_notes n ON n.transcript_id = t.id
     WHERE t.status = 'completed' AND n.id IS NULL
       AND t.text IS NOT NULL AND length(t.text) > 0
     ORDER BY t.completed_at NULLS LAST, t.created_at`,
  );
  let done = 0;
  for (const r of rows) {
    try {
      await generateAndStoreNotes(db, model, r.id);
      done += 1;
    } catch {
      // leave for the next tick; one bad transcript must not block the rest
    }
  }
  return done;
}

/**
 * One lecture-processing pass: finish any outstanding transcription, then turn
 * completed transcripts into notes. Safe to run on a schedule; idempotent.
 */
export async function runLectureTick(
  db: SqlClient,
  storage: StorageProvider,
  provider: TranscriptionProvider,
  bus: EventBus,
  model: ModelService,
): Promise<{ transcribed: number; noted: number }> {
  const transcribed = await transcribeStoredRecordings(db, storage, provider, bus);
  const noted = await processPendingLectureNotes(db, model);
  return { transcribed, noted };
}
