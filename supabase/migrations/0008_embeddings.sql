-- 0008_embeddings
-- Retrieval layer part 2: chunk embeddings for semantic search.
--
-- Stored as a float array (jsonb) so the interface is portable and testable
-- everywhere. PRODUCTION SCALING NOTE: swap this column for pgvector
-- `vector(<dim>)` and add an HNSW index (`USING hnsw (embedding vector_cosine_ops)`)
-- when the corpus grows; the embed/search interface stays identical and only the
-- ranking SQL changes.

ALTER TABLE transcript_chunks ADD COLUMN embedding jsonb;
