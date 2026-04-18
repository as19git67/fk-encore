# ── Stage 1: build dependencies ──────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS builder

WORKDIR /build

# Build toolchain for llama-cpp-python's native extension + HTTPS for pip.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --upgrade pip \
    && pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: runtime image ───────────────────────────────────────────────────
FROM python:3.12-slim-bookworm

# Match the TrueNAS SCALE "apps" user (568:568) used by the rest of the stack
# so bind-mounted volumes can be owned accordingly.
RUN groupadd --gid 568 apps \
    && useradd --uid 568 --gid 568 --create-home --shell /bin/bash apps \
    && getent passwd 568 \
    && getent group 568

# curl stays in the runtime image for the download script and healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /install /usr/local
COPY main.py ./
COPY download_model.sh /usr/local/bin/download_model.sh
RUN chmod +x /usr/local/bin/download_model.sh

# Models live in a bind-mounted volume, NOT in the image. The directory is
# created and chowned so the non-root runtime user can populate it via
# `download_model.sh` or by writing directly.
RUN mkdir -p /models \
    && chown -R 568:568 /models /app /home/apps

ENV MODELS_DIR=/models \
    LLM_MODEL_PATH=/models/llama.gguf \
    SENTENCE_TRANSFORMERS_HOME=/models/st-cache \
    HF_HOME=/models/hf-cache \
    EMBEDDING_MODEL=intfloat/multilingual-e5-base \
    LLM_CTX=8192 \
    LLM_GPU_LAYERS=0 \
    LOG_LEVEL=INFO \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

USER 568:568

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
