#!/usr/bin/env bash
# Idempotent ONNX export + INT8 quantisation of the embedding service's
# CLIP and DINOv2 weights.
#
# Reads the fp32 PyTorch checkpoints from ${HF_HOME} (populated by
# `download_model.sh` or the eager preload at first start), produces three
# fp32 ONNX graphs, then runs onnxruntime's dynamic quantiser to write
# INT8 versions into ${MODELS_DIR}/onnx/. The fp32 graphs are kept so the
# A/B eval can use them as a within-runtime reference if needed; delete
# manually once you're confident.
#
# Run as the `apps` user (568:568); the volume is already chowned by
# chown-init, so the script doesn't need root. Re-running is safe — it
# skips outputs that already exist with non-zero size. Set
# FORCE_REEXPORT=1 to redo from scratch (e.g. after upgrading torch or
# bumping the model name).
#
# Time budget on the production target (Intel 12600K, 6 P-core threads):
#   CLIP image:  ~3-5 min
#   CLIP text:   ~2-3 min
#   DINOv2:      ~30-60 s
# Peak RAM during one export step is ~6 GB.

set -euo pipefail

MODELS_DIR="${MODELS_DIR:-/models}"
export MODELS_DIR

# Re-export so the Python module sees the same view of the world the
# service does. Keep this list in sync with the Dockerfile ENV stanza.
export HF_HOME="${HF_HOME:-${MODELS_DIR}/hf-cache}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-${HF_HOME}/hub}"
export TORCH_HOME="${TORCH_HOME:-${MODELS_DIR}/torch-cache}"

CLIP_MODEL_NAME="${CLIP_MODEL_NAME:-xlm-roberta-large-ViT-H-14}"
CLIP_PRETRAINED="${CLIP_PRETRAINED:-frozen_laion5b_s13b_b90k}"
DINO_MODEL_NAME="${DINO_MODEL_NAME:-facebook/dinov2-base}"
export CLIP_MODEL_NAME CLIP_PRETRAINED DINO_MODEL_NAME

mkdir -p "${MODELS_DIR}/onnx"

echo "[optimize] MODELS_DIR=${MODELS_DIR}"
echo "[optimize] HF_HOME=${HF_HOME}"
echo "[optimize] CLIP=${CLIP_MODEL_NAME} (${CLIP_PRETRAINED})"
echo "[optimize] DINO=${DINO_MODEL_NAME}"

# Preflight: the export needs the fp32 weights to already be in HF_HOME.
# If the user skipped download_model.sh the eager preload at service
# startup may have populated it; otherwise fail early with a helpful hint.
if [[ ! -d "${HF_HOME}" ]] || [[ -z "$(ls -A "${HF_HOME}" 2>/dev/null)" ]]; then
  echo "[optimize] ERROR: ${HF_HOME} is empty." >&2
  echo "[optimize] Run /usr/local/bin/download_model.sh first to populate the cache." >&2
  exit 1
fi

# The export itself runs in Python — keep this script thin.
cd /app
exec python -m app.scripts.export_onnx
