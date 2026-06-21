#!/usr/bin/env bash
# Idempotent downloader for the llm-service model files.
#
# Pulls two artifacts into ${MODELS_DIR}:
#   1. the LLM GGUF file (Qwen2.5-7B-Instruct, quantised instruction-tuned weights),
#   2. the sentence-transformers embedding model repository.
#
# Re-running is safe — existing files are kept (curl --continue) and an
# existing embedding repo is just re-verified by huggingface_hub.
#
# The default URLs point at publicly-hosted community quantisations; override
# LLM_MODEL_URL / EMBEDDING_MODEL to use different weights.

set -euo pipefail

MODELS_DIR="${MODELS_DIR:-/models}"
LLM_MODEL_PATH="${LLM_MODEL_PATH:-${MODELS_DIR}/qwen2.5-7b-instruct-q4_k_m.gguf}"
LLM_MODEL_URL="${LLM_MODEL_URL:-https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf}"
LLM_MODEL_SHA256="${LLM_MODEL_SHA256:-}"  # optional integrity check

EMBEDDING_MODEL="${EMBEDDING_MODEL:-intfloat/multilingual-e5-base}"
SENTENCE_TRANSFORMERS_HOME="${SENTENCE_TRANSFORMERS_HOME:-${MODELS_DIR}/st-cache}"
export SENTENCE_TRANSFORMERS_HOME

mkdir -p "${MODELS_DIR}" "${SENTENCE_TRANSFORMERS_HOME}"

echo "[download] models dir: ${MODELS_DIR}"

# ── 1. GGUF ────────────────────────────────────────────────────────────────
if [[ -f "${LLM_MODEL_PATH}" ]]; then
  echo "[download] GGUF already present at ${LLM_MODEL_PATH} ($(du -h "${LLM_MODEL_PATH}" | cut -f1))"
else
  echo "[download] Fetching GGUF from ${LLM_MODEL_URL}"
  # -L: follow redirects, -C -: resume, --retry: ride out transient 5xx.
  curl -L -C - --fail --retry 5 --retry-delay 5 \
    -o "${LLM_MODEL_PATH}.part" \
    "${LLM_MODEL_URL}"
  mv "${LLM_MODEL_PATH}.part" "${LLM_MODEL_PATH}"
  echo "[download] GGUF saved to ${LLM_MODEL_PATH}"
fi

if [[ -n "${LLM_MODEL_SHA256}" ]]; then
  echo "[download] Verifying SHA256…"
  echo "${LLM_MODEL_SHA256}  ${LLM_MODEL_PATH}" | sha256sum -c -
fi

# ── 2. Embedding model ─────────────────────────────────────────────────────
echo "[download] Fetching embedding model ${EMBEDDING_MODEL} into ${SENTENCE_TRANSFORMERS_HOME}"
python - <<PY
from huggingface_hub import snapshot_download
import os

repo = os.environ["EMBEDDING_MODEL"]
target = os.environ["SENTENCE_TRANSFORMERS_HOME"]
# sentence-transformers stores models under a sanitised directory name.
local_dir = os.path.join(target, repo.replace("/", "_"))
os.makedirs(local_dir, exist_ok=True)
snapshot_download(
    repo_id=repo,
    local_dir=local_dir,
    local_dir_use_symlinks=False,
)
print(f"[download] Embedding model ready at {local_dir}")
PY

echo "[download] Done."
