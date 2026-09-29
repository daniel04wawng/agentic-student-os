-- 0023_resource_embeddings
-- Semantic retrieval for the study chat: store a sentence embedding per primer
-- chunk so questions can be matched by meaning, not just keywords. Embeddings
-- are jsonb float arrays (bge-small-en-v1.5, 384-dim), mirroring the
-- transcript_chunks pattern; cosine similarity is computed in app code. Swap to
-- pgvector + an HNSW index if this table grows large.
ALTER TABLE resource_chunks ADD COLUMN IF NOT EXISTS embedding jsonb;
