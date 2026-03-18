#!/usr/bin/env bash
set -euo pipefail

BACKEND_PORT="${BACKEND_PORT:-4000}"

encore run \
  --watch=false \
  --browser=never \
  --listen="0.0.0.0:${BACKEND_PORT}" &
BACK_PID=$!

cleanup() {
  if kill -0 "${BACK_PID}" >/dev/null 2>&1; then
    kill "${BACK_PID}" >/dev/null 2>&1 || true
    wait "${BACK_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM EXIT

nginx -g "daemon off;" &
NGINX_PID=$!

wait -n "${BACK_PID}" "${NGINX_PID}"
