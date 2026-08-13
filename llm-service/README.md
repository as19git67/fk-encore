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

`docker-compose.yml` can switch only the document-AI `llm_service` to GPU via
environment variables; InsightFace and photo embeddings remain on CPU. On a
host with NVIDIA Container Toolkit installed, set these values in `.env`:

```env
LLM_IMAGE_SUFFIX=-gpu
LLM_MODEL_PATH=/models/Qwen3-14B-Q4_K_M.gguf
LLM_MODEL_URL=https://huggingface.co/Qwen/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf
LLM_ACCELERATOR=cuda
LLM_GPU_LAYERS=-1
LLM_EMBED_DEVICE=cuda
LLM_GPU_COUNT=1
```

Then recreate the service from the single compose file:

```bash
docker compose --env-file .env -f docker-compose.yml \
  up -d --pull always --force-recreate llm_service
```

The first start downloads Qwen3-14B Q4_K_M into the existing `llm_models`
volume. To return to the CPU profile, set the `LLM_*` values back to the CPU
defaults from `docker-compose.env.example` and recreate:

```bash
docker compose --env-file .env -f docker-compose.yml \
  up -d --force-recreate llm_service
```

The `-llm-gpu` image ships `LLM_BATCH=2048`, `LLM_UBATCH=512` and
`LLM_FLASH_ATTN=1` as image defaults, but `docker-compose.yml` sets all four
tuning variables explicitly (a compose `environment:` entry always wins over the
image `ENV`), so put them in `.env` when using compose — see the GPU block in
`docker-compose.env.example`.

#### VRAM budget

Qwen3-14B costs **160 KiB of KV cache per token** (40 layers × 8 KV heads × 128
dims × [K+V] × 2 bytes) — roughly three times Qwen2.5-7B's 56 KiB, because of the
deeper stack and wider GQA group:

| `LLM_CTX` | KV (`f16`) | KV (`q8_0`) |
|---|---|---|
| 8192 | 1.25 GiB | 0.63 GiB |
| 18500 | 2.82 GiB | 1.41 GiB |
| 32768 | 5.00 GiB | 2.50 GiB |

On top of that come ~9 GB of Q4_K_M weights and ~1.5 GB for the E5 embedder plus
its CUDA context when `LLM_EMBED_DEVICE=cuda`. A 16 GB card therefore carries
`LLM_CTX=18500` comfortably at `f16`; for Qwen3's native 32k window set
`LLM_KV_TYPE=q8_0` (requires `LLM_FLASH_ATTN=1`).

If VRAM becomes tight, either set `LLM_KV_TYPE=q8_0` or move the E5 embedder back
to system RAM with `LLM_EMBED_DEVICE=cpu`. Watch the llama.cpp load log — once
`n_gpu_layers=-1` can no longer place all 41 layers, the layers that spill to the
host dominate every request and classification latency collapses.

#### Why `LLM_CTX` changes latency so sharply

`/classify` shrinks its prompt to fit the window: it drops the few-shot examples
first, then the taxonomy/doctype/tax-section *hints*, and only then returns 413.
The hints are by far the largest variable block — with them the prompt is roughly
17k tokens, without them roughly 8.5k. Raising `LLM_CTX` past the point where the
hints fit therefore doubles the prompt, and with it the prefill time, in one step.
`classify: dropping taxonomy/doctype/tax hints to fit n_ctx` in the log tells you
which side of that line a given deployment is on.

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
| `LLM_BATCH` | `512` | llama.cpp prompt-eval batch size (`n_batch`). The classifier prompt is ~15k tokens of fixed prefix before the document text, so prefill dominates `/classify`; `2048` keeps a GPU busy across that. No benefit on CPU. |
| `LLM_UBATCH` | `512` | Physical micro-batch (`n_ubatch`) inside each `LLM_BATCH`. |
| `LLM_FLASH_ATTN` | `0` | Enable FlashAttention. Worthwhile at long context on CUDA, and required for a quantised V cache. |
| `LLM_KV_TYPE` | `f16` | KV-cache element type: `f16`, `q8_0`, `q5_1`, `q5_0`, `q4_0`. `q8_0` halves KV memory at negligible quality cost — needs `LLM_FLASH_ATTN=1`. |
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
