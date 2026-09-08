-- 0014_approvals
-- Versioned approval. An approval is tied to the exact artifact remote_version;
-- any post-approval modification invalidates it. Invalidated rows are retained
-- as an audit trail.

CREATE TYPE approval_status AS ENUM ('active', 'invalidated');

CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   uuid NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  artifact_id     uuid NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  remote_version  text NOT NULL,
  actor           text NOT NULL,
  status          approval_status NOT NULL DEFAULT 'active',
  reason          text,
  approved_at     timestamptz NOT NULL DEFAULT now(),
  invalidated_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_artifact_idx ON approvals (artifact_id, status);
