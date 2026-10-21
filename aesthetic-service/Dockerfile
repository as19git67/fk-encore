# GPU image for the aesthetic scorer. Like llm-service/Dockerfile.gpu it is
# amd64-only and built on CUDA 12.8 so an RTX 50-series card gets native
# sm_120 code. There is no CPU variant: Q-Align needs 20–60 s per photo on a
# CPU, which is no use for a nightly batch over a photo library. The service
# still starts on a box without a card and reports that on /load.
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

# gcc, libc6-dev and python3-dev are for Triton, which torch brings along:
# when bitsandbytes is imported on a machine with a card, Triton compiles a
# small CUDA launcher against Python.h on first use and fails with "Failed
# to find C compiler" without them.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gcc \
    libc6-dev \
    python3 \
    python3-dev \
    python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 568 apps \
    && useradd --uid 568 --gid 568 --create-home --shell /bin/bash apps

WORKDIR /app

COPY requirements.txt .

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cu128 \
        torch==2.7.1 \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

ENV PATH=/opt/venv/bin:$PATH \
    MODELS_DIR=/models \
    HF_HOME=/models/hf-cache \
    AESTHETIC_MODEL_ID=q-future/one-align \
    AESTHETIC_DEVICE=cuda \
    AESTHETIC_QUANT=8bit \
    LOG_LEVEL=INFO \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY main.py scorer.py service_auth.py ./

RUN mkdir -p /models \
    && chown -R 568:568 /models /app /home/apps

EXPOSE 8000
USER 568:568

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
