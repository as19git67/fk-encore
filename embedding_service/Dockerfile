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

# Create a non-root "apps" user matching TrueNAS SCALE's built-in apps user
# (UID/GID 568) so bind-mounted ZFS datasets can be owned accordingly.
RUN groupadd -g 568 apps \
    && useradd -u 568 -g 568 -m -s /bin/bash apps

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Pre-download model weights at build time to avoid cold-start delays.
# open_clip and transformers cache under ~/.cache (via $HOME), so we point
# HOME at the apps user's home during the download.
RUN HOME=/home/apps python -c "\
import open_clip; \
open_clip.create_model_and_transforms('xlm-roberta-large-ViT-H-14', pretrained='frozen_laion5b_s13b_b90k'); \
print('OpenCLIP model pre-downloaded.') \
"
RUN HOME=/home/apps python -c "\
from transformers import AutoImageProcessor, AutoModel; \
AutoImageProcessor.from_pretrained('facebook/dinov2-base'); \
AutoModel.from_pretrained('facebook/dinov2-base'); \
print('DINOv2 model pre-downloaded.') \
"
RUN chown -R 568:568 /home/apps

# Copy application source
COPY app/ ./app/

# Runtime system deps (libpq for asyncpg)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R 568:568 /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LOG_LEVEL=INFO \
    HOME=/home/apps

EXPOSE 8000

USER 568:568

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
