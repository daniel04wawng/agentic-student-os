-- 0004_notifications
-- Persistent notification-worthy items + device push tokens. The notification
-- row is the AUTHORITATIVE in-app record; push delivery is a best-effort layer
-- on top, so a failed push never loses the underlying item.

CREATE TYPE device_platform AS ENUM ('ios', 'web');
CREATE TYPE notification_kind AS ENUM ('review_ready', 'deadline', 'admin', 'info');
CREATE TYPE notification_status AS ENUM ('pending', 'delivered', 'failed', 'dismissed');

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token         text NOT NULL UNIQUE,
  platform      device_platform NOT NULL DEFAULT 'ios',
  user_ref      text,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER devices_set_updated BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               notification_kind NOT NULL,
  title              text NOT NULL,
  body               text,
  subject_type       text,
  subject_id         uuid,
  status             notification_status NOT NULL DEFAULT 'pending',
  -- Idempotent creation: one notification per underlying thing.
  dedup_key          text,
  delivery_attempts  integer NOT NULL DEFAULT 0,
  last_error         text,
  delivered_at       timestamptz,
  dismissed_at       timestamptz,
  read_at            timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_dedup_uq ON notifications (dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX notifications_status_idx ON notifications (status);
CREATE TRIGGER notifications_set_updated BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
