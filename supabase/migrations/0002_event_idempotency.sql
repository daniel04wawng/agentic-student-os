-- 0002_event_idempotency
-- Make the event log replay-safe. Adds the idempotency key (unique) plus
-- processing/trace columns to `events`. The table is empty at this point (no
-- producers exist yet), so NOT NULL on idempotency_key is safe.

ALTER TABLE events
  ADD COLUMN idempotency_key text NOT NULL,
  ADD COLUMN trace_id       text,
  ADD COLUMN processed_at   timestamptz;

-- One row per unique fact: duplicate delivery collides here and is dropped.
CREATE UNIQUE INDEX events_idempotency_uq ON events (idempotency_key);

-- Find not-yet-processed events (recoverable state after a handler failure).
CREATE INDEX events_unprocessed_idx ON events (occurred_at) WHERE processed_at IS NULL;
