-- 0024_pageviews
-- Lightweight self-hosted web analytics: one row per page view. Privacy-light
-- (no PII); `visitor` is a coarse per-browser id from localStorage, used only
-- for unique-visitor counts.
CREATE TABLE IF NOT EXISTS pageviews (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path       text NOT NULL,
  referrer   text,
  visitor    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pageviews_created_idx ON pageviews (created_at);
