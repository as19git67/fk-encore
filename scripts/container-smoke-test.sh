#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${1:-fk-encore:smoke}"
HOST_PORT="${SMOKE_PORT:-18080}"
BASE_URL="http://127.0.0.1:${HOST_PORT}"
CONTAINER_NAME="fk-encore-smoke-${RANDOM}${RANDOM}"

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}

trap cleanup EXIT

echo "[smoke] Starting container ${CONTAINER_NAME} from ${IMAGE_NAME}"
docker run -d --name "${CONTAINER_NAME}" -p "${HOST_PORT}:8080" "${IMAGE_NAME}" >/dev/null

echo "[smoke] Waiting for /healthz"
for _ in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

health_body="$(curl -fsS "${BASE_URL}/healthz")"
if [[ "${health_body}" != *'"status":"ok"'* ]]; then
  echo "[smoke] Unexpected /healthz response: ${health_body}"
  exit 1
fi

health_content_type="$(curl -sS -o /dev/null -D - "${BASE_URL}/healthz" | grep -i '^Content-Type:' | head -n 1 | cut -d' ' -f2- | tr -d '\r')"
if [[ "${health_content_type}" != application/json* ]]; then
  echo "[smoke] Unexpected /healthz content-type: ${health_content_type}"
  exit 1
fi

echo "[smoke] Checking /health alias"
health_alias_body="$(curl -fsS "${BASE_URL}/health")"
if [[ "${health_alias_body}" != *'"status":"ok"'* ]]; then
  echo "[smoke] Unexpected /health response: ${health_alias_body}"
  exit 1
fi

echo "[smoke] Checking / redirect to /app/"
redirect_location="$(curl -sS -o /dev/null -D - "${BASE_URL}/" | grep -i '^Location:' | head -n 1 | cut -d' ' -f2 | tr -d '\r')"
if [[ "${redirect_location}" != "/app/" ]]; then
  echo "[smoke] Unexpected redirect location for /: ${redirect_location}"
  exit 1
fi

echo "[smoke] Checking /app/ returns HTML"
app_html="$(curl -fsS "${BASE_URL}/app/")"
if [[ "${app_html}" != *"<html"* ]]; then
  echo "[smoke] /app/ did not return HTML"
  exit 1
fi

echo "[smoke] Smoke test passed"

