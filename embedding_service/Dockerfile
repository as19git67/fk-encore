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
# getent asserts the user really made it into /etc/passwd — otherwise the
# build fails loudly instead of producing an image that crashes at runtime
# with "getpwuid(): uid not found: 568".
RUN groupadd --gid 568 apps \
    && useradd --uid 568 --gid 568 --create-home --shell /bin/bash apps \
    && getent passwd 568 \
    && getent group 568

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Models are NOT baked into the image — they are downloaded into the
# bind-mounted /models volume on first start (or explicitly populated via
# `download_model.sh`). Keeping them out of the image cuts the multi-arch
# CI build from ~15 min to ~3 min and from ~10 GB image size to ~800 MB,
# and allows iterating on quantisation without rebuilding.
#
# spaCy's de_core_news_md (~40 MB, NER for natural-language query parsing)
# is small enough to stay baked in: it ships as a pip-installable wheel,
# so installing it here costs less than wiring up a separate cache path.
ENV HOME=/home/apps
ENV USER=apps
ENV LOGNAME=apps
ENV MODELS_DIR=/models
ENV XDG_CACHE_HOME=/models/cache
ENV HF_HOME=/models/hf-cache
ENV HUGGINGFACE_HUB_CACHE=/models/hf-cache/hub
ENV TORCH_HOME=/models/torch-cache
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV LOG_LEVEL=INFO

# spaCy German NER model for natural-language query parsing.
# de_core_news_md is a pip-installable wheel — keeping it baked in avoids
# a separate cache path; payload is small (~40 MB).
RUN for attempt in 1 2 3 4 5; do \
         python -m spacy download de_core_news_md && break; \
         if [ "$attempt" = "5" ]; then echo "spaCy model download failed after 5 attempts"; exit 1; fi; \
         sleep_time=$((attempt * 30)); \
         echo "Attempt $attempt failed, retrying in ${sleep_time}s..."; \
         sleep "$sleep_time"; \
       done

# /models is the bind-mount target for the embedding_models volume; the
# embedding service writes its HF / torch caches and (later) ONNX-quantised
# weights here. Pre-creating + chowning means the non-root runtime user
# can populate it on first start without an extra init container.
RUN mkdir -p /models \
    && chown -R 568:568 /models /home/apps

# Copy application source + downloader / optimiser.
COPY app/ ./app/
COPY download_model.sh /usr/local/bin/download_model.sh
COPY optimize_models.sh /usr/local/bin/optimize_models.sh
RUN chmod +x /usr/local/bin/download_model.sh /usr/local/bin/optimize_models.sh

# Runtime system deps (libpq for asyncpg, curl for healthcheck + downloader)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R 568:568 /app

EXPOSE 8000

USER 568:568

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
