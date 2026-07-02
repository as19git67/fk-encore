# ── Stage 1: build dependencies ──────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS builder

ARG TARGETARCH

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Build llama-cpp-python without AVX-512 for broad CPU compatibility.
RUN if [ "$TARGETARCH" = "amd64" ]; then \
        export CMAKE_ARGS="-DGGML_NATIVE=OFF -DGGML_AVX512=OFF -DGGML_AVX512_VBMI=OFF -DGGML_AVX512_VNNI=OFF"; \
    else \
        export CMAKE_ARGS="-DGGML_NATIVE=OFF"; \
    fi && \
    pip install --upgrade pip \
    && pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: runtime image ──────────────────────────────────────────────────
FROM python:3.12-slim-bookworm

# Match the TrueNAS SCALE "apps" user (568:568)
RUN groupadd --gid 568 apps \
    && useradd --uid 568 --gid 568 --create-home --shell /bin/bash apps \
    && getent passwd 568

# Runtime dependencies: curl for healthcheck/download, libgomp for llama-cpp,
# libgl1 + libglib2.0 for OpenCV headless.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libgomp1 \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /install /usr/local
COPY main.py receipt_amount.py ./
COPY download_model.sh /usr/local/bin/download_model.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/download_model.sh /usr/local/bin/entrypoint.sh

RUN mkdir -p /models \
    && chown -R 568:568 /models /app /home/apps

# HOME points at the persisted /models volume so PaddleOCR's auto-downloaded
# models (~/.paddleocr) and any HuggingFace cache land there instead of the
# container's ephemeral home. Without this the PaddleOCR models are re-fetched
# from Baidu's servers (slow/unreliable from the EU) on every container
# recreate — i.e. after every Watchtower update — and the service answers 503
# until that download finishes. Persisting them means a one-time download.
ENV MODELS_DIR=/models \
    HOME=/models \
    LLM_MODEL_PATH=/models/qwen2.5-3b-instruct-q4_k_m.gguf \
    LLM_CTX=4096 \
    LLM_GPU_LAYERS=0 \
    OCR_LANG=latin \
    LOG_LEVEL=INFO \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

USER 568:568

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
