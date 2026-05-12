#!/usr/bin/env bash
# Container entrypoint for the embedding_service. Ensures the OpenCLIP +
# DINOv2 weights in ${HF_HOME} exist before uvicorn starts, then execs
# into the original CMD.
#
# download_model.sh is idempotent — huggingface_hub re-verifies the cache
# against the manifest and only pulls deltas, so a warm volume returns
# within a few seconds. On a cold volume the script pulls ~5.5 GB and
# can block for several minutes; the compose healthcheck's start_period
# (600 s) is sized for that.
#
# Set EMBEDDING_SKIP_DOWNLOAD=1 to bypass the check (e.g. when running a
# debug shell in the container and the network is unreachable).

set -euo pipefail

if [[ "${EMBEDDING_SKIP_DOWNLOAD:-0}" != "1" ]]; then
  echo "[entrypoint] Ensuring model artefacts are present in ${MODELS_DIR:-/models}…"
  /usr/local/bin/download_model.sh
else
  echo "[entrypoint] EMBEDDING_SKIP_DOWNLOAD=1 — skipping model download check"
fi

exec "$@"
