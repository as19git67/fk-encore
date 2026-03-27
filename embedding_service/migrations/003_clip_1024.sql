-- Migrate CLIP embedding column from 768 to 1024 dimensions (xlm-roberta-large-ViT-H-14)
-- This model uses a multilingual XLM-RoBERTa-Large text encoder with ViT-H-14 image encoder.
-- All existing CLIP embeddings must be regenerated after this migration.
ALTER TABLE photos ALTER COLUMN embedding_clip TYPE vector(1024);

DROP INDEX IF EXISTS idx_clip_embedding;
CREATE INDEX idx_clip_embedding ON photos USING hnsw (embedding_clip vector_cosine_ops);
