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

# Cache-related env vars as absolute paths. Set each on its own ENV line so
# they definitely propagate to both build-time RUN steps and the runtime CMD.
ENV HOME=/home/apps
ENV USER=apps
ENV LOGNAME=apps
ENV XDG_CACHE_HOME=/home/apps/.cache
ENV HF_HOME=/home/apps/.cache/huggingface
ENV HUGGINGFACE_HUB_CACHE=/home/apps/.cache/huggingface/hub
ENV TORCH_HOME=/home/apps/.cache/torch
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV LOG_LEVEL=INFO

# Pre-download model weights into the explicit cache dirs so the non-root
# apps user can load them at runtime. cache_dir= is passed explicitly so the
# download never depends on $HOME expansion. The shell retry loop rides out
# transient huggingface.co 503s during build — the libraries' built-in retry
# only waits up to 8s, which is too short for longer outages.
RUN mkdir -p /home/apps/.cache/huggingface /home/apps/.cache/torch \
    && for attempt in 1 2 3 4 5; do \
         python -c "import open_clip; open_clip.create_model_and_transforms('xlm-roberta-large-ViT-H-14', pretrained='frozen_laion5b_s13b_b90k', cache_dir='/home/apps/.cache/huggingface'); print('OpenCLIP model pre-downloaded.')" && break; \
         if [ "$attempt" = "5" ]; then echo "OpenCLIP download failed after 5 attempts"; exit 1; fi; \
         sleep_time=$((attempt * 30)); \
         echo "Attempt $attempt failed, retrying in ${sleep_time}s..."; \
         sleep "$sleep_time"; \
       done
RUN for attempt in 1 2 3 4 5; do \
         python -c "from transformers import AutoImageProcessor, AutoModel; AutoImageProcessor.from_pretrained('facebook/dinov2-base', cache_dir='/home/apps/.cache/huggingface'); AutoModel.from_pretrained('facebook/dinov2-base', cache_dir='/home/apps/.cache/huggingface'); print('DINOv2 model pre-downloaded.')" && break; \
         if [ "$attempt" = "5" ]; then echo "DINOv2 download failed after 5 attempts"; exit 1; fi; \
         sleep_time=$((attempt * 30)); \
         echo "Attempt $attempt failed, retrying in ${sleep_time}s..."; \
         sleep "$sleep_time"; \
       done
RUN chown -R 568:568 /home/apps

# Copy application source
COPY app/ ./app/

# Runtime system deps (libpq for asyncpg)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R 568:568 /app

EXPOSE 8000

USER 568:568

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
