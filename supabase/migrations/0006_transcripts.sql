-- 0006_transcripts
-- Transcription records for recordings. One transcript per recording. The audio
-- blob is never modified by transcription, so a provider failure never loses it.

CREATE TYPE transcription_status AS ENUM ('pending', 'processing', 'completed', 'failed');

CREATE TABLE transcripts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id  uuid NOT NULL UNIQUE REFERENCES recordings (id) ON DELETE CASCADE,
  status        transcription_status NOT NULL DEFAULT 'pending',
  provider      provider NOT NULL DEFAULT 'deepgram',
  language      text,
  duration_s    numeric,
  text          text,
  -- word-level timestamps + speaker labels; diarized utterance segments.
  words         jsonb NOT NULL DEFAULT '[]'::jsonb,
  utterances    jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_id    text,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  completed_at  timestamptz,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcripts_status_idx ON transcripts (status);
CREATE TRIGGER transcripts_set_updated BEFORE UPDATE ON transcripts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
