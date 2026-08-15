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
# With LLM_BACKEND=server a llama.cpp `llama-server` sidecar is started in the
# background first and the FastAPI app talks to it over HTTP — see
# llama_server.py for why that backend exists at all. Both processes then run
# under this script so that either one dying takes the container down, rather
# than leaving a half-alive service that answers /healthz with "starting"
# forever.

set -euo pipefail

if [[ "${LLM_SKIP_DOWNLOAD:-0}" != "1" ]]; then
  echo "[entrypoint] Ensuring model artefacts are present in ${MODELS_DIR:-/models}…"
  /usr/local/bin/download_model.sh
else
  echo "[entrypoint] LLM_SKIP_DOWNLOAD=1 — skipping model download check"
fi

if [[ "${LLM_BACKEND:-inproc}" != "server" ]]; then
  exec "$@"
fi

# ── llama-server sidecar ─────────────────────────────────────────────────────

LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-/usr/local/bin/llama-server}"
if [[ ! -x "${LLAMA_SERVER_BIN}" ]]; then
  # Not fatal: LLM_BACKEND=server against a llama-server running *outside* this
  # container (another compose service, another host) is a legitimate setup, and
  # only the -gpu image ships the binary. If no such server exists the app's
  # readiness wait says so with the URL it tried, which is the clearer error.
  echo "[entrypoint] LLM_BACKEND=server but ${LLAMA_SERVER_BIN} is not present —" >&2
  echo "[entrypoint] expecting an external llama-server at ${LLM_SERVER_URL:-http://127.0.0.1:8080}" >&2
  exec "$@"
fi

# Port is derived from LLM_SERVER_URL so there is a single source of truth for
# both sides of the loopback connection. Anything but a plain host:port URL is
# an operator error, so fail loudly instead of silently binding a default.
LLM_SERVER_URL="${LLM_SERVER_URL:-http://127.0.0.1:8080}"
LLAMA_PORT="${LLM_SERVER_URL##*:}"
LLAMA_PORT="${LLAMA_PORT%%/*}"
if [[ ! "${LLAMA_PORT}" =~ ^[0-9]+$ ]]; then
  echo "[entrypoint] cannot derive a port from LLM_SERVER_URL=${LLM_SERVER_URL}" >&2
  exit 1
fi

args=(
  --model "${LLM_MODEL_PATH:?LLM_MODEL_PATH must be set}"
  --host 127.0.0.1
  --port "${LLAMA_PORT}"
  --ctx-size "${LLM_CTX:-8192}"
  --batch-size "${LLM_BATCH:-512}"
  --ubatch-size "${LLM_UBATCH:-512}"
  --n-gpu-layers "${LLM_GPU_LAYERS:-0}"
  --cache-type-k "${LLM_KV_TYPE:-f16}"
  --cache-type-v "${LLM_KV_TYPE:-f16}"
  # The GGUF's own chat template. Required for correct Qwen3-family
  # formatting; llama.cpp's built-in fallback templates are close but not
  # identical, and a mis-templated system prompt degrades classification
  # quietly rather than loudly.
  --jinja
  --no-webui
)

# Expert offload — the reason this backend exists. N is the number of *leading*
# layers whose MoE expert tensors are kept in system RAM; the rest stay on the
# GPU. Tune it down until the card is nearly full: every layer that stays on
# the GPU is expert maths that does not have to happen on the CPU. 0 (the
# default) is a no-op and correct for a dense model.
if [[ "${LLM_NCMOE:-0}" != "0" && -n "${LLM_NCMOE:-}" ]]; then
  args+=(--n-cpu-moe "${LLM_NCMOE}")
fi

# Empty means "let llama.cpp pick" — compose passes ${LLM_THREADS:-} through as
# an empty string, which must not become `--threads ''`.
if [[ -n "${LLM_THREADS:-}" ]]; then
  args+=(--threads "${LLM_THREADS}")
fi

case "${LLM_FLASH_ATTN:-0}" in
  1|true|TRUE|yes|on) args+=(--flash-attn on) ;;
  *)                  args+=(--flash-attn off) ;;
esac

# Thinking off by default: /classify constrains the completion with a JSON
# grammar, so a reasoning block cannot be emitted anyway — but a hybrid model
# left in "auto" spends its budget trying. Set LLM_REASONING=auto to restore
# the model's own default.
args+=(--reasoning "${LLM_REASONING:-off}")

# Escape hatch for flags this wrapper does not model (e.g. --override-tensor
# for a hand-tuned split). Word-split on purpose.
if [[ -n "${LLM_SERVER_EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  args+=(${LLM_SERVER_EXTRA_ARGS})
fi

echo "[entrypoint] Starting llama-server: ${LLAMA_SERVER_BIN} ${args[*]}"
"${LLAMA_SERVER_BIN}" "${args[@]}" &
LLAMA_PID=$!

echo "[entrypoint] Starting app: $*"
"$@" &
APP_PID=$!

terminate() {
  trap - TERM INT
  kill -TERM "${LLAMA_PID}" "${APP_PID}" 2>/dev/null || true
}
trap terminate TERM INT

# Whichever process exits first takes the other with it, so a llama-server that
# dies mid-flight surfaces as a container restart instead of an app that 503s
# every request.
set +e
wait -n
status=$?
echo "[entrypoint] a child process exited (status ${status}) — shutting down the other"
terminate
wait
exit "${status}"
