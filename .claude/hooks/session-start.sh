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
#
# Migration 0054 needs the `halfvec` type, introduced in pgvector 0.7. Ubuntu
# Noble's main repo only ships 0.6.0, so we pull from PostgreSQL's official
# APT repository (apt.postgresql.org) where the latest pgvector is tracked.
# CI and prod already use the pgvector/pgvector:pg18 image which has 0.8+.

PG_APT_LIST=/etc/apt/sources.list.d/pgdg.list
if [ ! -f "$PG_APT_LIST" ]; then
  log "Adding apt.postgresql.org repository…"
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates gnupg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | sudo -n gpg --dearmor -o /usr/share/keyrings/pgdg-archive-keyring.gpg
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [signed-by=/usr/share/keyrings/pgdg-archive-keyring.gpg] http://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    | sudo -n tee "$PG_APT_LIST" >/dev/null
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get update -qq
fi

if ! dpkg -s postgresql-16 >/dev/null 2>&1; then
  log "Installing postgresql-16…"
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-16
fi

# Always ensure pgvector ≥ 0.7 is installed. If an older version is already
# present (Ubuntu Noble's 0.6.0) the apt upgrade pulls the pgdg variant.
PGVECTOR_VERSION=$(dpkg-query -W -f='${Version}' postgresql-16-pgvector 2>/dev/null || echo "")
if [ -z "$PGVECTOR_VERSION" ] || dpkg --compare-versions "$PGVECTOR_VERSION" lt "0.7"; then
  log "Installing/upgrading postgresql-16-pgvector (need ≥ 0.7 for halfvec)…"
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --allow-change-held-packages \
    postgresql-16-pgvector
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
