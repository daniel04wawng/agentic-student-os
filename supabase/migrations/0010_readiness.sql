-- 0010_readiness
-- Dynamic readiness contracts per assignment. Requirements are stored as a
-- jsonb array of {key, description, blocking, resolved}; the contract is "ready"
-- when every BLOCKING requirement is resolved. Contracts are revised when new
-- evidence appears (a new lecture can add a dependency).

CREATE TYPE readiness_status AS ENUM ('pending', 'ready');

CREATE TABLE readiness_contracts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id  uuid NOT NULL UNIQUE REFERENCES assignments (id) ON DELETE CASCADE,
  status         readiness_status NOT NULL DEFAULT 'pending',
  requirements   jsonb NOT NULL DEFAULT '[]'::jsonb,
  emitted_ready  boolean NOT NULL DEFAULT false,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX readiness_requirements_idx ON readiness_contracts USING GIN (requirements);
CREATE TRIGGER readiness_set_updated BEFORE UPDATE ON readiness_contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
