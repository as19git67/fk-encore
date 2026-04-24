-- Migration 0044: Embeddings for the finance-transaction tag suggester.
--
-- One 768-d vector per transaction (intfloat/multilingual-e5-base), so
-- tag-suggester.ts can look up the 20 nearest historical neighbours
-- when proposing AI tags for a new booking. Matches the shape used by
-- document_embeddings (see migration 0027), with a simpler PK because
-- finance transactions don't chunk.

CREATE TABLE finance_transaction_embedding (
    transaction_id BIGINT       PRIMARY KEY
                     REFERENCES finance_transaction(id) ON DELETE CASCADE,
    embedding      VECTOR(768)  NOT NULL,
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- HNSW index with cosine similarity, identical tuning to document_embeddings.
CREATE INDEX finance_transaction_embedding_hnsw
    ON finance_transaction_embedding
    USING hnsw (embedding vector_cosine_ops);
