import type { SqlClient } from '../db/client.js';
import type { TranscriptUtterance } from '../transcription/provider.js';
import { chunkText, chunkUtterances, type Chunk } from './chunk.js';
import type { Embedder } from './embed.js';

/**
 * Chunk a completed transcript and (re)write its chunks with course/session
 * context. Idempotent: re-indexing replaces the transcript's chunks.
 */
export async function indexTranscript(db: SqlClient, transcriptId: string): Promise<number> {
  const { rows } = await db.query<{
    text: string | null;
    utterances: TranscriptUtterance[];
    recording_id: string;
    session_id: string | null;
    course_id: string | null;
  }>(
    `SELECT t.text, t.utterances, t.recording_id, r.session_id, s.course_id
     FROM transcripts t
     JOIN recordings r ON r.id = t.recording_id
     LEFT JOIN sessions s ON s.id = r.session_id
     WHERE t.id = $1`,
    [transcriptId],
  );
  if (rows.length === 0) throw new Error(`transcript not found: ${transcriptId}`);
  const row = rows[0]!;

  const utterances = row.utterances ?? [];
  const chunks: Chunk[] =
    utterances.length > 0 ? chunkUtterances(utterances) : chunkText(row.text ?? '');

  // Replace existing chunks for idempotent re-indexing.
  await db.query(`DELETE FROM transcript_chunks WHERE transcript_id = $1`, [transcriptId]);

  let index = 0;
  for (const chunk of chunks) {
    await db.query(
      `INSERT INTO transcript_chunks
         (transcript_id, recording_id, session_id, course_id, chunk_index, text, start_s, end_s)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        transcriptId,
        row.recording_id,
        row.session_id,
        row.course_id,
        index,
        chunk.text,
        chunk.start_s,
        chunk.end_s,
      ],
    );
    index += 1;
  }
  return index;
}

/**
 * Compute and store embeddings for a transcript's chunks that don't have one
 * yet. Idempotent: only unembedded chunks are processed, so re-running is cheap
 * and never re-embeds unchanged text (cost control).
 */
export async function embedTranscriptChunks(
  db: SqlClient,
  embedder: Embedder,
  transcriptId: string,
): Promise<number> {
  const { rows } = await db.query<{ id: string; text: string }>(
    `SELECT id, text FROM transcript_chunks
     WHERE transcript_id = $1 AND embedding IS NULL
     ORDER BY chunk_index`,
    [transcriptId],
  );
  if (rows.length === 0) return 0;

  const vectors = await embedder.embed(rows.map((r) => r.text));
  for (let i = 0; i < rows.length; i += 1) {
    await db.query(`UPDATE transcript_chunks SET embedding = $2::jsonb WHERE id = $1`, [
      rows[i]!.id,
      JSON.stringify(vectors[i]),
    ]);
  }
  return rows.length;
}
