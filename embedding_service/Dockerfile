# ── Stage 1: build dependencies ──────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS builder

WORKDIR /build

# System deps for psycopg2 / asyncpg compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    git \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --upgrade pip \
    && pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: runtime image ───────────────────────────────────────────────────
FROM python:3.12-slim-bookworm

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Pre-download model weights at build time to avoid cold-start delays
RUN python -c "\
import open_clip; \
open_clip.create_model_and_transforms('xlm-roberta-large-ViT-H-14', pretrained='frozen_laion5b_s13b_b90k'); \
print('OpenCLIP model pre-downloaded.') \
"
RUN python -c "\
from transformers import AutoImageProcessor, AutoModel; \
AutoImageProcessor.from_pretrained('facebook/dinov2-base'); \
AutoModel.from_pretrained('facebook/dinov2-base'); \
print('DINOv2 model pre-downloaded.') \
"

# Copy application source
COPY app/ ./app/

# Runtime system deps (libpq for asyncpg)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LOG_LEVEL=INFO

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
