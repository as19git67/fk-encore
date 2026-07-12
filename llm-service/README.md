# LLM Service

A FastAPI-based microservice that hosts a local GGUF model for structured document classification and a **multilingual-e5-base** transformer for high-quality text embeddings. The default image uses Qwen2.5-7B on CPU; the optional document-AI GPU profile uses Qwen3-14B on NVIDIA CUDA.

---

## Architecture

```
llm-service/
  main.py               # FastAPI application, model lifecycle, and UTF-8 repair
  Dockerfile            # Python 3.12-slim base with llama-cpp-python
  Dockerfile.gpu        # CUDA 12.8 / RTX 50-series image
  docker-compose.yml    # Service-local deployment config
  download_model.sh     # Idempotent downloader for GGUF and HF weights
  requirements.txt      # Core dependencies (torch, llama-cpp-python, etc.)
  tests/                # Unit tests for classification and schemas
```

---

## Quick Start

### 1. Docker Compose (recommended)

```bash
cd llm-service
docker compose up --build
```

This starts the **LLM Service** on port `8001`.

> **Note**: The container entrypoint (`entrypoint.sh`) runs
> `download_model.sh` automatically before `uvicorn` starts. The script
> is idempotent — warm volumes return in seconds; a cold volume pulls
> ~3 GB of weights, covered by the compose healthcheck's `start_period`.
> Set `LLM_SKIP_DOWNLOAD=1` to bypass the check (e.g. in debug shells
> without network). Pre-populating manually with
> `docker compose run --rm llm-service /usr/local/bin/download_model.sh`
> still works for power users.

### 2. Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Download models locally
MODELS_DIR=./models ./download_model.sh

# Start the service
MODELS_DIR=./models uvicorn main:app --reload --port 8001
```

### NVIDIA GPU profile

The repository-level `docker-compose.gpu.yml` only replaces `llm_service`.
InsightFace and photo embeddings remain on CPU. On a host with NVIDIA
Container Toolkit installed, start the document-AI profile with:

```bash
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.gpu.yml \
  up -d --pull always --force-recreate llm_service
```

The first start downloads Qwen3-14B Q4_K_M into the existing `llm_models`
volume. To return to the CPU profile, omit the override and recreate:

```bash
docker compose --env-file .env -f docker-compose.yml \
  up -d --force-recreate llm_service
```

If 16 GB VRAM becomes tight, keep llama.cpp on the GPU but move the E5
embedder back to system RAM with `LLM_GPU_EMBED_DEVICE=cpu`.

---

## API Reference

Interactive docs: [http://localhost:8001/docs](http://localhost:8001/docs)

### `GET /healthz`
Returns service health, model loading status, and current memory usage (RSS).

### `POST /classify`
Performs structured classification of document text into a given taxonomy. Supports optional German tax-section detection.
```json
{
  "text": "Invoice for web design services...",
  "taxonomy": [
    { "slug": "invoice", "name": "Rechnung" },
    { "slug": "contract", "name": "Vertrag" }
  ],
  "max_tags": 5
}
```

### `POST /embed`
Generates text embeddings using the E5 model. Automatically applies `query:` or `passage:` prefixes.
```json
{
  "texts": ["This is a sample document", "Another one"],
  "kind": "passage"
}
```

### `POST /json-prompt`
A generic endpoint for JSON-mode chat completions. Useful for finance tag suggestions or free-text analysis.
```json
{
  "prompt": "Extract the vendor name from this receipt: ...",
  "system": "You are a data extraction assistant."
}
```

### `POST /recap-title`
Generates warm, personal titles and subtitles for private photo recaps (e.g., "A Summer in Paris").

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MODELS_DIR` | `/models` | Root directory for model artefacts |
| `LLM_MODEL_URL` | `https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf` | Download source for the LLM GGUF file |
| `LLM_MODEL_PATH` | `/models/qwen2.5-7b-instruct-q4_k_m.gguf` | Local path to the GGUF model file |
| `LLM_CTX` | `8192` | Context window size |
| `LLM_THREADS` | `$(nproc)` | CPU threads for inference |
| `LLM_ACCELERATOR` | `cpu` | Runtime guard: `cpu` or `cuda` |
| `LLM_GPU_LAYERS` | `0` | llama.cpp layers offloaded to GPU; the GPU profile uses `-1` (all) |
| `LLM_EMBED_DEVICE` | `cpu` | Sentence-Transformer device: `cpu`, `cuda`, or `auto` |
| `LLM_EMBED_BATCH_SIZE` | `32` | Chunk size `encode()` uses internally when `/embed` receives a large text list. Raise for higher GPU throughput on big batches; lower if VRAM is tight. |
| `CLASSIFY_TEXT_CHAR_LIMIT` | `6000` | Max document characters fed to `/classify` (cheap pre-cap before the n_ctx token guard). Keep ≥ the app's `DOCUMENTS_CLASSIFY_CHAR_LIMIT`; raise both in lockstep with `LLM_CTX` to classify longer documents. |
| `TAX_SECTIONS_MAX` | `4` | Dump-all backstop: when `/classify` returns more than this many tax sections at once it is treated as a confused small-model output and the entire tax assignment is dropped. Set to `0` to disable. |
| `EMBEDDING_MODEL` | `intfloat/multilingual-e5-base` | Sentence-Transformers repo or path |
| `LOG_LEVEL` | `INFO` | Logging verbosity |

---

## Features

### UTF-8 / Mojibake Repair
The service includes a specialized repair layer for `llama-cpp-python`'s JSON-grammar-constrained generation. It detects and fixes multi-byte UTF-8 codepoints (like German umlauts) that were split across tokens and incorrectly decoded as Latin-1 (e.g., fixing `BrÃ¼ssel` back to `Brüssel`).

### Single-Worker Inference
To prevent CPU contention and keep the event loop responsive for health checks, all heavy inference tasks are serialized through a single-worker `ThreadPoolExecutor`.
