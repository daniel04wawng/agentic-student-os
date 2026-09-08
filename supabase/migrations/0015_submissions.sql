-- 0015_submissions
-- Canvas submission state machine. One submission per assignment. A submission
-- is only 'verified' after we read it back from Canvas (a successful write call
-- is not proof). Idempotent: submitted/verified rows are never re-sent.

CREATE TYPE submission_status AS ENUM ('pending', 'submitting', 'submitted', 'verified', 'failed');

CREATE TABLE submissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id         uuid NOT NULL UNIQUE REFERENCES assignments (id) ON DELETE CASCADE,
  artifact_id           uuid REFERENCES artifacts (id) ON DELETE SET NULL,
  status                submission_status NOT NULL DEFAULT 'pending',
  canvas_submission_id  text,
  verified              boolean NOT NULL DEFAULT false,
  attempts              integer NOT NULL DEFAULT 0,
  last_error            text,
  submitted_at          timestamptz,
  verified_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER submissions_set_updated BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
