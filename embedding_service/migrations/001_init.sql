-- Migration 001: initial schema for embedding service
-- Run automatically by docker-compose via docker-entrypoint-initdb.d,
-- or manually: psql $DATABASE_URL -f migrations/001_init.sql

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS photos (
  photo_id        TEXT PRIMARY KEY,
  file_path       TEXT NOT NULL,
  timestamp       TIMESTAMP,
  camera_id       TEXT,
  face_ids        TEXT[],
  embedding_clip  VECTOR(512),
  embedding_dino  VECTOR(768),
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clip_embedding
  ON photos USING hnsw (embedding_clip vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_dino_embedding
  ON photos USING hnsw (embedding_dino vector_cosine_ops);
