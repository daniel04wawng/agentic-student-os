import type { SqlClient } from '../db/client.js';

export interface ChunkHit {
  id: string;
  transcript_id: string;
  course_id: string | null;
  chunk_index: number;
  text: string;
  start_s: number | null;
  rank: number;
}

export interface SearchOptions {
  courseId?: string;
  limit?: number;
}

/**
 * Full-text search over transcript chunks using Postgres tsvector/ts_rank.
 * Optionally scoped to a course. Returns only relevant chunks (not whole
 * transcripts), ranked by relevance.
 */
export async function fullTextSearch(
  db: SqlClient,
  query: string,
  opts: SearchOptions = {},
): Promise<ChunkHit[]> {
  const limit = opts.limit ?? 10;
  const { rows } = await db.query<ChunkHit>(
    `SELECT id, transcript_id, course_id, chunk_index, text, start_s,
            ts_rank(tsv, plainto_tsquery('english', $1)) AS rank
     FROM transcript_chunks
     WHERE tsv @@ plainto_tsquery('english', $1)
       AND ($2::uuid IS NULL OR course_id = $2::uuid)
     ORDER BY rank DESC
     LIMIT $3`,
    [query, opts.courseId ?? null, limit],
  );
  return rows;
}
