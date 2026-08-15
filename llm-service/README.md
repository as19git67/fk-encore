# LLM Service

A FastAPI-based microservice that hosts a local GGUF model for structured document classification and a **multilingual-e5-base** transformer for high-quality text embeddings. The default image uses Qwen2.5-7B on CPU; the optional document-AI GPU profile runs Qwen3-14B — or a larger Mixture-of-Experts model with its experts offloaded to system RAM — on NVIDIA CUDA.

---

## Architecture

```
llm-service/
  main.py               # FastAPI application, model lifecycle, and UTF-8 repair
  llm_config.py         # The knobs that pick a model, from env or from a file
  llama_server.py       # HTTP client for the llama-server backend
  llama_supervisor.py   # Owns the llama-server subprocess (start/stop/crash)
  model_downloads.py    # Runtime GGUF downloads, listing, deletion
  Dockerfile            # Python 3.12-slim base with llama-cpp-python
  Dockerfile.gpu        # CUDA 12.8 / RTX 50-series image, ships llama-server
  docker-compose.yml    # Service-local deployment config
  download_model.sh     # Idempotent downloader for GGUF and HF weights
  entrypoint.sh         # Model download, then uvicorn
  requirements.txt      # Core dependencies (torch, llama-cpp-python, etc.)
  tests/                # Unit tests for classification and schemas
```

### Two inference backends

`LLM_BACKEND` selects where the GGUF actually runs. The embedder is unaffected
— sentence-transformers always runs inside the FastAPI process.

| | `inproc` | `server` |
|---|---|---|
| Runtime | `llama-cpp-python` in-process | `llama-server` sidecar over HTTP |
| Shipped by | CPU image | GPU image (its default) |
| MoE expert offload | not available | `LLM_NCMOE` |

The split exists for one reason: llama-cpp-python cannot pass llama.cpp's
tensor-buffer overrides. `llama_model_params.tensor_buft_overrides` is present
in its ctypes struct but marked `# NOTE: unused`, and `Llama.__init__` has no
keyword for it. Those overrides are what `--n-cpu-moe` is built on, so a
Mixture-of-Experts model larger than VRAM can only be placed sensibly by
`llama-server`. Everything else about the two paths is identical — including
`/classify`'s JSON-schema grammar, which llama-server compiles from the same
schema object the binding does.

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

#### Running a MoE model larger than VRAM

The spill warning above is about *dense* models, where `n_gpu_layers` is the
only lever and a spilled layer takes its attention with it. A Mixture-of-Experts
model has a better option. Its bulk is in the expert FFN tensors, and only a
few experts are read per token, so those tensors can sit in system RAM while
attention, the shared weights and the KV cache stay on the GPU:

```env
LLM_IMAGE_SUFFIX=-gpu
LLM_BACKEND=server
LLM_NCMOE=32          # experts of the first 32 layers live in system RAM
LLM_GPU_LAYERS=-1
LLM_ACCELERATOR=cuda
```

`LLM_NCMOE` is a dial, not a switch. Start with it at the model's layer count
(all experts on the CPU), then lower it until `nvidia-smi` shows the card nearly
full during a `/classify` — every layer won back is expert arithmetic the CPU
does not have to do. `LLM_SERVER_EXTRA_ARGS` takes raw `--override-tensor`
patterns when a uniform split is not what you want.

Two things decide whether this is worth doing, and both have to be measured on
the actual host:

* **Prefill, not decode.** The usual argument for MoE offload — only ~3 B of
  parameters are active per token, so reading them from RAM is cheap — applies
  to *generation*, which is bandwidth-bound and short here (a few hundred JSON
  tokens). `/classify` is dominated by prefill of a five-figure prompt, and a
  batch of thousands of tokens activates effectively every expert. That is the
  regime where CPU-resident experts cost the most.
* **Architecture support.** The GGUF loads only if the llama.cpp build pinned
  in `Dockerfile.gpu` (`LLAMA_CPP_REF`) knows its architecture. Check before
  deploying — `llama-server --model <file> --ctx-size 512` on the host either
  prints the loaded tensor layout or fails with `unknown model architecture`.

KV cache is usually *cheaper* for these models, not more expensive: a 48-layer
A3B-class model with 4 KV heads × 128 dims spends ~96 KiB/token against
Qwen3-14B's 160 KiB, i.e. ~1.7 GiB at `LLM_CTX=18000` instead of ~2.8 GiB.

Budget the host side too: the offloaded experts are resident memory, not page
cache, and `documents/llm-client.ts` gives up on a classification after
`LLM_SERVICE_TIMEOUT_MS` (default 120 s) — raise it, and keep it below
`LLM_SERVER_REQUEST_TIMEOUT`, if a document now takes longer than that.

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

## Switching models at runtime

The service can be pointed at a different model without editing `.env` and
recreating the container. The app stores named configurations in its
`llm_model_config` table and activates one through the endpoints below.

**Precedence — this is the part that matters for an existing deployment.** On
start the service looks for `${MODELS_DIR}/.active_config.json`. That file only
exists once something has been activated. Without it the service reads its
environment exactly as it always has, so a deployment that never uses this
feature keeps running on its compose/.env values, across image updates
included. `POST /config/reset` deletes the file and goes back to that state.

A configuration is persisted only *after* it has loaded successfully, so a
model that cannot be read never becomes the one the container boots into. If a
load fails the service rolls back to the previous configuration; only if that
also fails does it stay down, at which point the compose healthcheck restarts
it.

| Endpoint | Purpose |
|---|---|
| `GET /config` | The live configuration and where it came from (`env` / `file`) |
| `POST /reload` | Activate a configuration — accepts an `llm_model_config` row as JSON, answers `202` |
| `GET /reload/status` | Progress of the swap: `idle` → `stopping` → `downloading` → `loading` → `ready` / `error` |
| `POST /config/reset` | Discard the activated configuration and return to the environment |
| `GET /models/files` | GGUF files on the volume, their sizes, and free space |
| `POST /models/download` | Fetch a GGUF (plus shards) in the background, answers `202` |
| `GET /models/download/status` | Bytes, throughput, ETA |
| `POST /models/download/cancel` | Stop the transfer, keeping the `.part` file so the next attempt resumes |
| `DELETE /models/files/{filename}` | Remove a model that is not currently loaded |

Inference is unavailable while a swap runs: `_state["llm"]` is cleared first,
which the existing guards turn into a `503`, and the app's `llm-client` already
treats a `503` as "defer and retry later". Embeddings are unaffected — the
embedder is a separate model and is never reloaded.

Downloading is a separate step from activating on purpose. Fetching 26 GB and
loading it are minutes apart in cost, so pull the weights first, watch the
progress, and activate once the file is on the volume — that keeps the actual
outage to the load itself.

### Who owns llama-server

For `LLM_BACKEND=server` the FastAPI process starts and stops the
`llama-server` subprocess itself (`llama_supervisor.py`); `entrypoint.sh` no
longer does. Switching models means stopping the old server and starting a new
one with different arguments, which the app cannot do to a sibling process it
did not spawn.

The property `entrypoint.sh` provided with `wait -n` is preserved: a
llama-server that exits on its own takes the service down rather than leaving
it answering `503` forever. A stop the app asked for is not treated as a crash.

If the image ships no `llama-server` binary, `LLM_BACKEND=server` still works
against one running elsewhere — the app then only attaches over
`LLM_SERVER_URL` and manages no process.

---

## Configuration

These are the *fallback* values: they apply whenever no configuration has been
activated through the admin UI (see [Switching models at
runtime](#switching-models-at-runtime)). Once one is active, everything from
`LLM_MODEL_PATH` down to `LLM_SERVER_REQUEST_TIMEOUT` comes from it instead;
`MODELS_DIR`, the embedder settings, `CLASSIFY_TEXT_CHAR_LIMIT`,
`TAX_SECTIONS_MAX` and `LOG_LEVEL` are always read from the environment.

| Variable | Default | Description |
|---|---|---|
| `MODELS_DIR` | `/models` | Root directory for model artefacts |
| `LLM_MODEL_URL` | `https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf` | Download source for the LLM GGUF file |
| `LLM_MODEL_EXTRA_URLS` | — | Space-separated URLs of further shards of a split GGUF. Point `LLM_MODEL_PATH` at shard 1; llama.cpp finds the rest. |
| `LLM_MODEL_PATH` | `/models/qwen2.5-7b-instruct-q4_k_m.gguf` | Local path to the GGUF model file |
| `LLM_CTX` | `8192` | Context window size |
| `LLM_THREADS` | `$(nproc)` | CPU threads for inference |
| `LLM_ACCELERATOR` | `cpu` | Runtime guard: `cpu` or `cuda` |
| `LLM_GPU_LAYERS` | `0` | llama.cpp layers offloaded to GPU; the GPU profile uses `-1` (all) |
| `LLM_BATCH` | `512` | llama.cpp prompt-eval batch size (`n_batch`). The classifier prompt is ~15k tokens of fixed prefix before the document text, so prefill dominates `/classify`; `2048` keeps a GPU busy across that. No benefit on CPU. |
| `LLM_UBATCH` | `512` | Physical micro-batch (`n_ubatch`) inside each `LLM_BATCH`. |
| `LLM_FLASH_ATTN` | `0` | Enable FlashAttention. Worthwhile at long context on CUDA, and required for a quantised V cache. |
| `LLM_KV_TYPE` | `f16` | KV-cache element type: `f16`, `q8_0`, `q5_1`, `q5_0`, `q4_0`. `q8_0` halves KV memory at negligible quality cost — needs `LLM_FLASH_ATTN=1`. |
| `LLM_BACKEND` | `inproc` | Where the GGUF runs: `inproc` (llama-cpp-python) or `server` (llama-server sidecar). The `-gpu` image defaults to `server`. |
| `LLM_NCMOE` | `0` | `server` only: keep the MoE expert tensors of the first N layers in system RAM (`--n-cpu-moe`). `0` disables it. |
| `LLM_REASONING` | `off` | `server` only: `off`, `on` or `auto`. `/classify` is grammar-constrained, so a thinking block is wasted budget. |
| `LLM_SERVER_URL` | `http://127.0.0.1:8080` | `server` only: sidecar address. Its port is also the one the app binds llama-server to. |
| `LLAMA_SERVER_BIN` | `/usr/local/bin/llama-server` | `server` only: the binary to launch. When absent the app attaches to an external llama-server at `LLM_SERVER_URL` instead of managing a process. |
| `LLM_SERVER_EXTRA_ARGS` | — | `server` only: raw llama-server flags appended verbatim (e.g. `--override-tensor`). |
| `LLM_SERVER_READY_TIMEOUT` | `900` | `server` only: seconds to wait for the sidecar to finish loading before startup fails. |
| `LLM_SERVER_REQUEST_TIMEOUT` | `900` | `server` only: per-request deadline against the sidecar. Keep above the caller's `LLM_SERVICE_TIMEOUT_MS`. |
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
