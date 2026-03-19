#!/usr/bin/env bash
set -euo pipefail

APP_PORT="${PORT:-8080}"

exec encore run \
  --watch=false \
  --browser=never \
  --listen="0.0.0.0:${APP_PORT}"
