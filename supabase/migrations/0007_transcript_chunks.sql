-- 0007_transcript_chunks
-- Retrieval layer part 1: transcript chunks + full-text search. Embeddings
-- (pgvector) and hierarchical summaries are added in 0008.

CREATE TABLE transcript_chunks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id  uuid NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
  recording_id   uuid REFERENCES recordings (id) ON DELETE CASCADE,
  session_id     uuid REFERENCES sessions (id) ON DELETE SET NULL,
  course_id      uuid REFERENCES courses (id) ON DELETE SET NULL,
  chunk_index    integer NOT NULL,
  text           text NOT NULL,
  start_s        numeric,
  end_s          numeric,
  -- Immutable regconfig makes the generated tsvector valid.
  tsv            tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transcript_chunks_uq ON transcript_chunks (transcript_id, chunk_index);
CREATE INDEX transcript_chunks_tsv_idx ON transcript_chunks USING GIN (tsv);
CREATE INDEX transcript_chunks_transcript_idx ON transcript_chunks (transcript_id);
CREATE INDEX transcript_chunks_course_idx ON transcript_chunks (course_id);
