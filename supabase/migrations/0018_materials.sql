-- 0018_materials
-- Extracted text of course materials (readings, cases, slides). We download the
-- source file, extract its text in memory, and store ONLY the text here — the
-- original PDF is never persisted (storage-friendly). One row per source file.

CREATE TABLE materials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid REFERENCES courses (id) ON DELETE CASCADE,
  session_id    uuid REFERENCES sessions (id) ON DELETE SET NULL,
  kind          text NOT NULL DEFAULT 'reading',
  title         text,
  content_type  text,
  byte_size     bigint,
  text          text NOT NULL DEFAULT '',
  source        provider NOT NULL DEFAULT 'canvas',
  source_id     text,
  source_url    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX materials_source_uq ON materials (source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX materials_course_idx ON materials (course_id);
CREATE TRIGGER materials_set_updated BEFORE UPDATE ON materials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
