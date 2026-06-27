#!/usr/bin/env bash
# Idempotent downloader for the receipt-ocr-service model files.
#
# Pulls:
#   1. Small LLM GGUF (Qwen2.5-3B-Instruct Q4_K_M, ~2 GB)
#   2. PaddleOCR models (auto-downloaded on first use, but pre-fetched here)
#
# Re-running is safe — existing files are kept.

set -euo pipefail

MODELS_DIR="${MODELS_DIR:-/models}"
LLM_MODEL_PATH="${LLM_MODEL_PATH:-${MODELS_DIR}/qwen2.5-3b-instruct-q4_k_m.gguf}"
LLM_MODEL_URL="${LLM_MODEL_URL:-https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf}"
LLM_MODEL_SHA256="${LLM_MODEL_SHA256:-}"

mkdir -p "${MODELS_DIR}"
echo "[download] models dir: ${MODELS_DIR}"

# ── 1. GGUF ──────────────────────────────────────────────────────────────────
if [[ -f "${LLM_MODEL_PATH}" ]]; then
  echo "[download] GGUF already present at ${LLM_MODEL_PATH} ($(du -h "${LLM_MODEL_PATH}" | cut -f1))"
else
  echo "[download] Fetching GGUF from ${LLM_MODEL_URL}"
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

# ── 2. PaddleOCR models (pre-warm) ──────────────────────────────────────────
echo "[download] Pre-warming PaddleOCR models…"
python - <<'PY'
import os
os.environ.setdefault("FLAGS_call_stack_level", "0")
from paddleocr import PaddleOCR
ocr = PaddleOCR(use_angle_cls=True, lang=os.environ.get("OCR_LANG", "latin"), show_log=False, use_gpu=False)
print("[download] PaddleOCR models cached.")
PY

echo "[download] Done."
