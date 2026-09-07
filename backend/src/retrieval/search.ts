import type { SqlClient } from '../db/client.js';
import { cosineSimilarity, type Embedder } from './embed.js';

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

export interface SemanticHit {
  id: string;
  transcript_id: string;
  course_id: string | null;
  chunk_index: number;
  text: string;
  start_s: number | null;
  score: number;
}

/**
 * Semantic search: embed the query and rank embedded chunks by cosine
 * similarity. Ranking is done in application code over candidate chunks (see the
 * migration note about swapping in a pgvector ANN index for scale). Optionally
 * scoped to a course.
 */
export async function semanticSearch(
  db: SqlClient,
  embedder: Embedder,
  query: string,
  opts: SearchOptions = {},
): Promise<SemanticHit[]> {
  const limit = opts.limit ?? 10;
  const [queryVec] = await embedder.embed([query]);
  if (!queryVec) return [];

  const { rows } = await db.query<{
    id: string;
    transcript_id: string;
    course_id: string | null;
    chunk_index: number;
    text: string;
    start_s: number | null;
    embedding: number[];
  }>(
    `SELECT id, transcript_id, course_id, chunk_index, text, start_s, embedding
     FROM transcript_chunks
     WHERE embedding IS NOT NULL
       AND ($1::uuid IS NULL OR course_id = $1::uuid)`,
    [opts.courseId ?? null],
  );

  return rows
    .map((r) => ({
      id: r.id,
      transcript_id: r.transcript_id,
      course_id: r.course_id,
      chunk_index: r.chunk_index,
      text: r.text,
      start_s: r.start_s,
      score: cosineSimilarity(queryVec, r.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
