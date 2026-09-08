-- 0013_review_packets
-- Review packets: a concise, human-reviewable summary of a REVIEW_READY artifact
-- (summary, main argument, warnings, review-time estimate, artifact link +
-- version, source links). One per (assignment, artifact version).

CREATE TABLE review_packets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key               text NOT NULL UNIQUE,
  assignment_id     uuid NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  artifact_id       uuid NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  artifact_version  integer NOT NULL,
  summary           text NOT NULL DEFAULT '',
  main_argument     text NOT NULL DEFAULT '',
  warnings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_minutes    integer NOT NULL DEFAULT 0,
  artifact_uri      text,
  source_links      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_packets_assignment_idx ON review_packets (assignment_id);
