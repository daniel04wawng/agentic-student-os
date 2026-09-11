-- 0019_lecture_notes
-- Granola-style AI notes for a recorded lecture. One notes row per transcript;
-- content is a synthesized study note (summary / key points / topics / action
-- items / questions) generated from the transcript by the model.

CREATE TYPE lecture_notes_status AS ENUM ('pending', 'ready', 'failed');

CREATE TABLE lecture_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id uuid NOT NULL UNIQUE REFERENCES transcripts (id) ON DELETE CASCADE,
  recording_id  uuid REFERENCES recordings (id) ON DELETE CASCADE,
  session_id    uuid REFERENCES sessions (id) ON DELETE SET NULL,
  course_id     uuid REFERENCES courses (id) ON DELETE SET NULL,
  status        lecture_notes_status NOT NULL DEFAULT 'ready',
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lecture_notes_course_idx ON lecture_notes (course_id);
CREATE TRIGGER lecture_notes_set_updated BEFORE UPDATE ON lecture_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
