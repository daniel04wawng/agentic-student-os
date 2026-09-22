-- 0021_users
-- App user accounts. Identity comes from Sign in with Apple (apple_sub is the
-- stable per-user id Apple returns); we mint our own session tokens against this
-- row. This id becomes the tenant id (user_id) on data tables in a later phase.

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apple_sub  text UNIQUE,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_set_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
