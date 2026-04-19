#!/bin/bash
# Session-start hook: prepares the sandbox so vitest (backend) + npm builds
# (frontend) run out-of-the-box. Idempotent; safe to run multiple times.
#
# Only runs on Claude Code on the web — local dev environments manage their
# own Postgres/Docker stack.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

log() { printf '[session-start] %s\n' "$*" >&2; }

# ── 1. Postgres 16 + pgvector ─────────────────────────────────────────────
# The backend vitest suite's globalSetup creates/drops `encore_test` against
# a Postgres reachable at localhost:5432 with user=postgres / password=postgres
# and requires the pgvector extension.

if ! dpkg -s postgresql-16 >/dev/null 2>&1; then
  log "Installing postgresql-16…"
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-16
fi

if ! dpkg -s postgresql-16-pgvector >/dev/null 2>&1; then
  log "Installing postgresql-16-pgvector…"
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-16-pgvector
fi

if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  log "Starting postgresql cluster 16/main…"
  sudo -n pg_ctlcluster 16 main start >/dev/null 2>&1 || true
  # Wait until the socket is ready (max ~10s).
  for _ in $(seq 1 20); do
    pg_isready -h localhost -p 5432 -q && break
    sleep 0.5
  done
fi

# Align the postgres role password with what vitest.config.ts expects.
sudo -n -u postgres psql -v ON_ERROR_STOP=1 -tAc \
  "ALTER USER postgres WITH PASSWORD 'postgres';" >/dev/null

log "Postgres ready on localhost:5432 (pgvector available)"

# ── 2. Node dependencies ──────────────────────────────────────────────────
cd "$CLAUDE_PROJECT_DIR"

if [ ! -d node_modules ]; then
  log "Installing root npm dependencies…"
  npm install --no-audit --no-fund --silent
fi

if [ ! -d frontend/node_modules ]; then
  log "Installing frontend npm dependencies…"
  (cd frontend && npm install --no-audit --no-fund --silent)
fi

log "Done. Backend vitest and frontend build should now run."
