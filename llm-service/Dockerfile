# ── Stage 1: build dependencies ──────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS builder

ARG TARGETARCH

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

# Build llama-cpp-python without AVX-512 so the image runs on CPUs that
# only support AVX2 (e.g. older Xeon / AMD EPYC on NAS hardware).
# GGML_NATIVE=OFF disables march=native; the AVX-512 flags disable those
# code paths explicitly. Without this the binary crashes with SIGILL (exit
# 132) on first inference on non-AVX-512 hosts.
RUN if [ "$TARGETARCH" = "amd64" ]; then \
        export CMAKE_ARGS="-DGGML_NATIVE=OFF -DGGML_AVX512=OFF -DGGML_AVX512_VBMI=OFF -DGGML_AVX512_VNNI=OFF"; \
    else \
        export CMAKE_ARGS="-DGGML_NATIVE=OFF"; \
    fi && \
    pip install --upgrade pip \
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
# libgomp1 provides libgomp.so.1, required by llama-cpp-python's libllama.so
# (OpenMP runtime) — without it model load fails with
# "libgomp.so.1: cannot open shared object file".
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /install /usr/local
# llama_server.py and llama_supervisor.py are inert under this image's
# LLM_BACKEND=inproc default; they are copied so the CPU image can still be
# pointed at an external llama-server.
COPY main.py llama_server.py llama_supervisor.py llm_config.py model_downloads.py ./
COPY download_model.sh /usr/local/bin/download_model.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/download_model.sh /usr/local/bin/entrypoint.sh

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

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
