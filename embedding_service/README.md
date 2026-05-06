# Embedding Service

A production-ready Python microservice that generates **multilingual CLIP** (semantic) and **DINOv2** (visual similarity) image embeddings, stores them in PostgreSQL via **pgvector**, and exposes a REST API for batch embedding, similarity search, and retrieval.

---

## Architecture

```
embedding_service/
  app/
    main.py              # FastAPI application entry point
    config.py            # Environment-based configuration (pydantic-settings)
    api/
      endpoints.py       # Route handlers (/embed, /search, /quality, etc.)
    services/
      embedding_service.py # Torch/ONNX lazy-loaded model singletons
      onnx_backend.py      # ONNX Runtime inference logic
      query_parser.py      # NLP-based natural language query parsing
      similar_groups.py    # Sliding-window similarity clustering
    db/
      database.py        # Async SQLAlchemy engine + session factory
      orm_models.py      # Photo ORM model (pgvector columns)
      repository.py      # Data access layer (upsert, query, search)
    models/
      schemas.py         # Pydantic request/response schemas
    scripts/
      export_onnx.py     # Model export and INT8 quantization tool
  migrations/
    001_init.sql         # Initial schema (vector extension, tables)
    002_clip_768.sql     # Migration to 768-dim CLIP
    003_clip_1024.sql    # Migration to 1024-dim CLIP (XLM-RoBERTa)
    migrate.py           # Standalone migration runner
  requirements.txt
  Dockerfile
  docker-compose.yml
  download_model.sh      # Warm-up script for model weights
  optimize_models.sh     # Script to generate ONNX/INT8 artefacts
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

> **Note**: On first start, the service downloads ~5.5 GB of model weights. Use `./download_model.sh` to pre-populate the volume.

### 2. Local Development

```bash
# Install dependencies
pip install -r requirements.txt
python -m spacy download de_core_news_md

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
Batch-generates embeddings for existing local files and stores them.
```json
{
  "photos": [
    { "photo_id": "abc123", "file_path": "/photos/abc123.jpg" }
  ]
}
```

### `POST /upload`
Uploads a photo file directly, generates embeddings, and stores them. (Multipart/Form-Data)

### `POST /search`
Finds the `k` most similar photos using cosine similarity based on an existing photo.
```json
{ "photo_id": "abc123", "k": 10, "mode": "hybrid" }
```
`mode`: `clip` | `dino` | `hybrid` (score fusion)

### `POST /search_text`
Semantic search using a natural language query (multilingual).
```json
{ "query": "a cat sitting on a red sofa", "k": 10 }
```

### `POST /quality`
Calculates a composite quality score (0.0 - 1.0) based on aesthetics, sharpness, and composition.

### `POST /similar-groups`
Clusters photos into visually similar groups within a sliding time window.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://...` | Async SQLAlchemy DB URL |
| `CLIP_MODEL_NAME` | `xlm-roberta-large-ViT-H-14` | OpenCLIP model architecture |
| `CLIP_PRETRAINED` | `frozen_laion5b_s13b_b90k` | Multilingual pretrained weights |
| `DINO_MODEL_NAME` | `facebook/dinov2-base` | HuggingFace DINOv2 model |
| `EMBED_BACKEND` | `torch` | Inference engine (`torch` or `onnx`) |
| `LAZY_LOAD_MODELS`| `false` | If true, models load on first request |

---

## ONNX & Quantization

For faster CPU inference, the service supports ONNX with INT8 quantization for the CLIP visual tower.
1. Run `docker compose exec embedding_service /usr/local/bin/optimize_models.sh`.
2. Set `EMBED_BACKEND=onnx` in your environment.

---

## Database Schema

The service uses **pgvector** for high-performance similarity search:
- `embedding_clip`: `VECTOR(1024)` (XLM-RoBERTa-Large-ViT-H-14)
- `embedding_dino`: `VECTOR(768)` (DINOv2-base)

HNSW indexes are used for sub-millisecond similarity queries.
