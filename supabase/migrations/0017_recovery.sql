-- 0017_recovery
-- Retry queue for recoverable operations. Failures move work into an explicit
-- recoverable state here rather than being lost.

CREATE TYPE retry_status AS ENUM ('queued', 'done', 'dead');

CREATE TABLE retry_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  subject_type    text,
  subject_id      uuid,
  status          retry_status NOT NULL DEFAULT 'queued',
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retry_queue_due_idx ON retry_queue (next_attempt_at) WHERE status = 'queued';
CREATE TRIGGER retry_queue_set_updated BEFORE UPDATE ON retry_queue FOR EACH ROW EXECUTE FUNCTION set_updated_at();
