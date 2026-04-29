#!/usr/bin/env bash
# Idempotent downloader for the embedding service's image / text encoders.
#
# Pulls two models into ${MODELS_DIR} (defaults to /models, which is the
# bind-mounted volume target inside the container):
#   1. OpenCLIP — multilingual ViT-H-14 (XLM-RoBERTa-Large text encoder)
#   2. DINOv2 — facebook/dinov2-base (image-only)
#
# Both end up in ${HF_HOME}; the service auto-resolves them via that env
# var when the embedders are first instantiated. Running the script before
# `docker compose up` keeps the first request fast (~30 s startup instead
# of ~5 min cold-cache download). Re-running is safe — huggingface_hub
# verifies cache contents against the manifest and only re-pulls deltas.
#
# Override CLIP_MODEL_NAME / CLIP_PRETRAINED / DINO_MODEL_NAME to swap in
# different weights without rebuilding the image.

set -euo pipefail

MODELS_DIR="${MODELS_DIR:-/models}"
export HF_HOME="${HF_HOME:-${MODELS_DIR}/hf-cache}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-${HF_HOME}/hub}"
export TORCH_HOME="${TORCH_HOME:-${MODELS_DIR}/torch-cache}"

CLIP_MODEL_NAME="${CLIP_MODEL_NAME:-xlm-roberta-large-ViT-H-14}"
CLIP_PRETRAINED="${CLIP_PRETRAINED:-frozen_laion5b_s13b_b90k}"
DINO_MODEL_NAME="${DINO_MODEL_NAME:-facebook/dinov2-base}"

mkdir -p "${HF_HOME}" "${TORCH_HOME}"

echo "[download] MODELS_DIR=${MODELS_DIR}"
echo "[download] HF_HOME=${HF_HOME}"

# ── 1. OpenCLIP (image + text encoders) ───────────────────────────────────
# create_model_and_transforms is the same call the service makes at
# startup, so anything it would download lazily we just trigger here. The
# shell-level retry rides out transient 5xx from huggingface.co — the
# library's own retry only waits up to 8s, which is too short for longer
# outages.
for attempt in 1 2 3 4 5; do
  if python -c "
import open_clip
open_clip.create_model_and_transforms('${CLIP_MODEL_NAME}', pretrained='${CLIP_PRETRAINED}')
print('[download] OpenCLIP ready')
"; then
    break
  fi
  if [ "${attempt}" = "5" ]; then
    echo "[download] OpenCLIP failed after 5 attempts" >&2
    exit 1
  fi
  delay=$((attempt * 30))
  echo "[download] OpenCLIP attempt ${attempt} failed, retrying in ${delay}s..." >&2
  sleep "${delay}"
done

# ── 2. DINOv2 (image encoder only) ────────────────────────────────────────
for attempt in 1 2 3 4 5; do
  if python -c "
from transformers import AutoImageProcessor, AutoModel
AutoImageProcessor.from_pretrained('${DINO_MODEL_NAME}')
AutoModel.from_pretrained('${DINO_MODEL_NAME}')
print('[download] DINOv2 ready')
"; then
    break
  fi
  if [ "${attempt}" = "5" ]; then
    echo "[download] DINOv2 failed after 5 attempts" >&2
    exit 1
  fi
  delay=$((attempt * 30))
  echo "[download] DINOv2 attempt ${attempt} failed, retrying in ${delay}s..." >&2
  sleep "${delay}"
done

echo "[download] All models present in ${HF_HOME}."
du -sh "${HF_HOME}" "${TORCH_HOME}" 2>/dev/null || true
