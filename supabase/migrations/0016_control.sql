-- 0016_control
-- Manual control plane state. Persistent per-scope control: pause/resume,
-- deferral until an event, and permission policy overrides. One row per
-- (scope, scope_id); scope_id is NULL for the global scope.

CREATE TYPE control_scope AS ENUM ('global', 'course', 'assignment');

CREATE TABLE control_state (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            control_scope NOT NULL,
  scope_id         uuid,
  paused           boolean NOT NULL DEFAULT false,
  policy           text,
  deferred_until   text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- One row per scope target (global row uses a sentinel via COALESCE in code).
CREATE UNIQUE INDEX control_state_scope_uq
  ON control_state (scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TRIGGER control_state_set_updated BEFORE UPDATE ON control_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();
