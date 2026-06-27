#!/usr/bin/env bash
# Container entrypoint for receipt-ocr-service.
# Downloads model artefacts if missing, then execs into CMD.

set -euo pipefail

if [[ "${SKIP_DOWNLOAD:-0}" != "1" ]]; then
  echo "[entrypoint] Ensuring model artefacts are present in ${MODELS_DIR:-/models}…"
  /usr/local/bin/download_model.sh
else
  echo "[entrypoint] SKIP_DOWNLOAD=1 — skipping model download check"
fi

exec "$@"
