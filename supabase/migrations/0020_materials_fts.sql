-- 0020_materials_fts
-- Full-text search over course material text so the chat assistant can retrieve
-- the relevant readings/cases for a question. Materials had no FTS index before
-- (transcript_chunks already has one). Generated column stays in sync on write.

ALTER TABLE materials
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(text, ''))) STORED;

CREATE INDEX materials_tsv_idx ON materials USING GIN (tsv);
