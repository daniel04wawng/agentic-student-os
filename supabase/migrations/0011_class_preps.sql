-- 0011_class_preps
-- Pre-class preparation artifacts. One prep per session; content is a synthesized
-- study aid (overview / prior recap / key points / questions).

CREATE TYPE class_prep_status AS ENUM ('pending', 'ready', 'failed');

CREATE TABLE class_preps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL UNIQUE REFERENCES sessions (id) ON DELETE CASCADE,
  course_id     uuid REFERENCES courses (id) ON DELETE SET NULL,
  status        class_prep_status NOT NULL DEFAULT 'ready',
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,
  notified      boolean NOT NULL DEFAULT false,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER class_preps_set_updated BEFORE UPDATE ON class_preps FOR EACH ROW EXECUTE FUNCTION set_updated_at();
