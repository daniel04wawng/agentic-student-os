-- 0022_resource_chunks
-- Chunked course resources (primers, textbook sections) for retrieval. Mirrors
-- the transcript_chunks pattern: small, individually-searchable pieces tagged by
-- course, so prep and chat can pull the few relevant chunks instead of a whole
-- book. Full-text index on a generated tsvector.

CREATE TABLE resource_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid REFERENCES courses (id) ON DELETE CASCADE,
  source_title text,          -- e.g. "Primer 07" or "Tariffs and the Macroeconomy"
  section      text,          -- section heading when known
  chunk_index  integer NOT NULL DEFAULT 0,
  text         text NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_chunks_tsv_idx ON resource_chunks USING GIN (tsv);
CREATE INDEX resource_chunks_course_idx ON resource_chunks (course_id);
