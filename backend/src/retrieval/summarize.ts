import type { SqlClient } from '../db/client.js';

/**
 * Deterministic hierarchical summaries: section (per chunk) -> session/lecture
 * -> course. No LLM: summaries are truncated/rolled-up chunk text. The `key`
 * makes regeneration idempotent (upsert). Richer LLM summaries can replace the
 * text later without schema change (metadata.method records provenance).
 */
const SECTION_MAX = 160;
const SESSION_MAX = 600;
const COURSE_MAX = 1000;

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

async function upsertSummary(
  db: SqlClient,
  row: {
    scope: string;
    key: string;
    courseId: string | null;
    sessionId: string | null;
    transcriptId: string | null;
    chunkIndex: number | null;
    text: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO summaries (scope, key, course_id, session_id, transcript_id, chunk_index, text, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7, jsonb_build_object('method','deterministic_truncation'))
     ON CONFLICT (key) DO UPDATE
       SET text = excluded.text, metadata = excluded.metadata`,
    [row.scope, row.key, row.courseId, row.sessionId, row.transcriptId, row.chunkIndex, row.text],
  );
}

/** Build section summaries per chunk + one session/lecture summary. */
export async function buildTranscriptSummaries(
  db: SqlClient,
  transcriptId: string,
): Promise<{ sections: number }> {
  const { rows: chunks } = await db.query<{ chunk_index: number; text: string }>(
    `SELECT chunk_index, text FROM transcript_chunks WHERE transcript_id = $1 ORDER BY chunk_index`,
    [transcriptId],
  );
  const ctx = await db.query<{ session_id: string | null; course_id: string | null }>(
    `SELECT r.session_id, s.course_id
     FROM transcripts t JOIN recordings r ON r.id = t.recording_id
     LEFT JOIN sessions s ON s.id = r.session_id WHERE t.id = $1`,
    [transcriptId],
  );
  const { session_id, course_id } = ctx.rows[0] ?? { session_id: null, course_id: null };

  const sectionTexts: string[] = [];
  for (const chunk of chunks) {
    const text = truncate(chunk.text, SECTION_MAX);
    sectionTexts.push(text);
    await upsertSummary(db, {
      scope: 'section',
      key: `section:${transcriptId}:${chunk.chunk_index}`,
      courseId: course_id,
      sessionId: session_id,
      transcriptId,
      chunkIndex: chunk.chunk_index,
      text,
    });
  }

  await upsertSummary(db, {
    scope: 'session',
    key: `session:${transcriptId}`,
    courseId: course_id,
    sessionId: session_id,
    transcriptId,
    chunkIndex: null,
    text: truncate(sectionTexts.join(' '), SESSION_MAX),
  });

  return { sections: chunks.length };
}

/** Roll up a course's session summaries into a course summary. */
export async function buildCourseSummary(db: SqlClient, courseId: string): Promise<void> {
  const { rows } = await db.query<{ text: string }>(
    `SELECT text FROM summaries WHERE course_id = $1 AND scope = 'session' ORDER BY updated_at`,
    [courseId],
  );
  await upsertSummary(db, {
    scope: 'course',
    key: `course:${courseId}`,
    courseId,
    sessionId: null,
    transcriptId: null,
    chunkIndex: null,
    text: truncate(rows.map((r) => r.text).join(' '), COURSE_MAX),
  });
}
