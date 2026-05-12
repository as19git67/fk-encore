#!/usr/bin/env bash
# Container entrypoint for the llm_service. Ensures the model artefacts
# in ${MODELS_DIR} exist before uvicorn starts, then execs into the
# original CMD.
#
# download_model.sh is idempotent — if the GGUF and the
# sentence-transformers cache are already present it returns within a
# second or two. On a cold volume it downloads ~3 GB of weights and can
# block for several minutes; the compose healthcheck's start_period
# (180 s) is sized for that.
#
# Set LLM_SKIP_DOWNLOAD=1 to bypass the check (e.g. when running a
# debug shell in the container and the network is unreachable).

set -euo pipefail

if [[ "${LLM_SKIP_DOWNLOAD:-0}" != "1" ]]; then
  echo "[entrypoint] Ensuring model artefacts are present in ${MODELS_DIR:-/models}…"
  /usr/local/bin/download_model.sh
else
  echo "[entrypoint] LLM_SKIP_DOWNLOAD=1 — skipping model download check"
fi

exec "$@"
