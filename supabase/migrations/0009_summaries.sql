-- 0009_summaries
-- Hierarchical summaries: section (per chunk) -> session/lecture -> course.
-- Deterministic for now; the `key` column makes (re)generation idempotent.

CREATE TYPE summary_scope AS ENUM ('section', 'session', 'course');

CREATE TABLE summaries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          summary_scope NOT NULL,
  key            text NOT NULL UNIQUE,
  course_id      uuid REFERENCES courses (id) ON DELETE CASCADE,
  session_id     uuid REFERENCES sessions (id) ON DELETE SET NULL,
  transcript_id  uuid REFERENCES transcripts (id) ON DELETE CASCADE,
  chunk_index    integer,
  text           text NOT NULL,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX summaries_course_idx ON summaries (course_id, scope);
CREATE TRIGGER summaries_set_updated BEFORE UPDATE ON summaries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
