#!/usr/bin/env bash
# Container entrypoint for the llm_service. Ensures the model artefacts
# in ${MODELS_DIR} exist before uvicorn starts, then execs into the
# original CMD.
#
# download_model.sh is idempotent — if the GGUF and the
# sentence-transformers cache are already present it returns within a
# second or two. On a cold volume it downloads several GB of weights and can
# block for many minutes; the compose healthcheck's start_period is sized
# for that.
#
# Set LLM_SKIP_DOWNLOAD=1 to bypass the check (e.g. when running a
# debug shell in the container and the network is unreachable).
#
# This script no longer starts the llama-server sidecar for LLM_BACKEND=server.
# The app owns that subprocess (see llama_supervisor.py), because switching
# models at runtime means stopping the old server and starting a new one with
# different arguments — which the app cannot do to a sibling process. The
# "a dead llama-server takes the container down" property that `wait -n`
# provided here is preserved there.

set -euo pipefail

MODELS_DIR="${MODELS_DIR:-/models}"

# An activated configuration names its own model, which is generally not the
# one LLM_MODEL_URL points at. Downloading the environment's GGUF here would
# pull several GB nobody asked for, so leave the weights to the app, which
# fetches whatever the activated configuration names. The embedding model is
# unaffected by all of this and still gets its check.
if [[ -f "${MODELS_DIR}/.active_config.json" ]]; then
  echo "[entrypoint] Activated configuration present — leaving the GGUF to the app"
  export LLM_SKIP_GGUF_DOWNLOAD=1
fi

if [[ "${LLM_SKIP_DOWNLOAD:-0}" != "1" ]]; then
  echo "[entrypoint] Ensuring model artefacts are present in ${MODELS_DIR}…"
  /usr/local/bin/download_model.sh
else
  echo "[entrypoint] LLM_SKIP_DOWNLOAD=1 — skipping model download check"
fi

exec "$@"
