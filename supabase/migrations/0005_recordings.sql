-- 0005_recordings
-- Audio recording records. The row is the authoritative metadata; the audio
-- blob lives in object storage referenced by storage_key. Registration is
-- idempotent on a client-generated id so a device retry never duplicates.

CREATE TYPE recording_status AS ENUM ('pending', 'uploading', 'stored', 'failed');

CREATE TABLE recordings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     text NOT NULL UNIQUE,
  session_id    uuid REFERENCES sessions (id) ON DELETE SET NULL,
  title         text,
  status        recording_status NOT NULL DEFAULT 'pending',
  content_type  text NOT NULL DEFAULT 'application/octet-stream',
  storage_key   text,
  duration_ms   integer,
  byte_size     bigint,
  captured_at   timestamptz,
  uploaded_at   timestamptz,
  last_error    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recordings_status_idx ON recordings (status);
CREATE TRIGGER recordings_set_updated BEFORE UPDATE ON recordings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
