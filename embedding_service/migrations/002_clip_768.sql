-- Migrate CLIP embedding column from 512 to 768 dimensions (ViT-L/14)
ALTER TABLE photos ALTER COLUMN embedding_clip TYPE vector(768);

DROP INDEX IF EXISTS idx_clip_embedding;
CREATE INDEX idx_clip_embedding ON photos USING hnsw (embedding_clip vector_cosine_ops);
