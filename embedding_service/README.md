# Embedding Service

A production-ready Python microservice that generates **OpenCLIP** (semantic) and **DINOv2** (visual similarity) image embeddings, stores them in PostgreSQL via **pgvector**, and exposes a REST API for batch embedding, similarity search, and retrieval.

---

## Architecture

```
embedding_service/
  app/
    main.py            # FastAPI application entry point
    config.py          # Environment-based configuration (pydantic-settings)
    api/
      endpoints.py     # Route handlers: /embed, /search, /get, /health
    services/
      embedding_service.py  # OpenCLIP + DINOv2 lazy-loaded singletons
    db/
      database.py      # Async SQLAlchemy engine + session factory
      orm_models.py    # Photo ORM model (pgvector columns)
      repository.py    # Data access layer (upsert, query, search)
    models/
      schemas.py       # Pydantic request/response schemas
  migrations/
    001_init.sql       # Initial schema (pgvector extension, tables, HNSW indexes)
    migrate.py         # Standalone migration runner
  requirements.txt
  Dockerfile
  docker-compose.yml
```

---

## Quick Start

### 1. Docker Compose (recommended)

```bash
cd embedding_service
docker compose up --build
```

This starts:
- **PostgreSQL 16** with pgvector extension on port `5432`
- **Embedding Service** on port `8000`

The SQL migration (`migrations/001_init.sql`) is applied automatically on first startup via `docker-entrypoint-initdb.d`.

> **Note**: mount your photo storage by editing the `volumes` section in `docker-compose.yml`.

### 2. Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Apply database schema
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/embeddings \
  python migrations/migrate.py

# Start the service
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/embeddings \
  uvicorn app.main:app --reload
```

---

## API Reference

Interactive docs: [http://localhost:8000/docs](http://localhost:8000/docs)

### `GET /health`
Returns service health including DB connectivity and model loading status.

### `POST /embed`
Batch-generates CLIP + DINOv2 embeddings and stores them (skips existing `photo_id`s).

```json
{
  "photos": [
    {
      "photo_id": "abc123",
      "file_path": "/photos/abc123.jpg",
      "timestamp": "2024-01-15T10:30:00",
      "camera_id": "cam-01",
      "face_ids": ["face_a", "face_b"]
    }
  ]
}
```

Response:
```json
{ "status": "ok", "processed": 1 }
```

### `POST /search`
Finds the `k` most similar photos using cosine similarity.

```json
{ "photo_id": "abc123", "k": 10, "mode": "hybrid" }
```

`mode` options: `clip` | `dino` | `hybrid` (0.5 CLIP + 0.5 DINOv2 score fusion)

### `POST /get`
Returns embeddings and metadata for a list of photo IDs.

```json
{ "photo_ids": ["abc123", "def456"] }
```

---

## Configuration

All settings can be overridden via environment variables or a `.env` file:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://postgres:postgres@localhost:5432/embeddings` | Async SQLAlchemy DB URL |
| `DB_POOL_SIZE` | `5` | Connection pool size |
| `DB_MAX_OVERFLOW` | `10` | Max overflow connections |
| `CLIP_MODEL_NAME` | `ViT-B-32` | OpenCLIP model architecture |
| `CLIP_PRETRAINED` | `openai` | OpenCLIP pretrained weights |
| `DINO_MODEL_NAME` | `facebook/dinov2-base` | HuggingFace DINOv2 model |
| `LOG_LEVEL` | `INFO` | Logging verbosity |

---

## GPU Support

The service detects CUDA automatically. To use GPU, replace the torch wheel in `requirements.txt` with a CUDA-enabled build:

```
torch==2.3.1+cu121
torchvision==0.18.1+cu121
--extra-index-url https://download.pytorch.org/whl/cu121
```

And adjust the Dockerfile base image or add the CUDA runtime accordingly.

---

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE photos (
  photo_id        TEXT PRIMARY KEY,
  file_path       TEXT NOT NULL,
  timestamp       TIMESTAMP,
  camera_id       TEXT,
  face_ids        TEXT[],
  embedding_clip  VECTOR(512),
  embedding_dino  VECTOR(768),
  created_at      TIMESTAMP DEFAULT NOW()
);

-- HNSW indexes for fast cosine similarity search
CREATE INDEX idx_clip_embedding ON photos USING hnsw (embedding_clip vector_cosine_ops);
CREATE INDEX idx_dino_embedding ON photos USING hnsw (embedding_dino vector_cosine_ops);
```
