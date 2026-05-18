#!/usr/bin/env bash
#
# One-time migration for the fk-encore test stack:
#   encore     → encore_test
#   embeddings → embeddings_test
#
# Run this BEFORE switching the test stack onto the new unified
# docker-compose.yml + docker-compose.env.test.example workflow that
# expects the *_test database names. Otherwise the first start
# against the new env-file will create empty `encore_test` /
# `embeddings_test` databases next to your existing test data and
# you'd be left wondering where the photos went.
#
# What it does, in order:
#   1. Stops the app + embedding service (so they release their
#      connections to the source databases).
#   2. Terminates any stray Postgres connections still open against
#      `encore` / `embeddings` — required, otherwise ALTER DATABASE
#      bails out with "database is being accessed by other users".
#   3. Runs `ALTER DATABASE … RENAME TO …` for both databases.
#   4. Prints the next steps (edit `.env.test`, bring the stack up).
#
# Idempotent: if `encore_test` already exists the rename for that one
# is skipped (same for embeddings_test). Safe to re-run after a
# partial failure.
#
# Inputs (env overrides; defaults match the standard test stack):
#   POSTGRES_CONTAINER   — the test postgres container name
#   APP_CONTAINER        — the test app container name
#   EMBEDDING_CONTAINER  — the test embedding service container name
#   SOURCE_APP_DB        — DB currently used by the app
#   SOURCE_EMBED_DB      — DB currently used by the embedding service
#   TARGET_APP_DB        — DB name to rename the app DB to
#   TARGET_EMBED_DB      — DB name to rename the embedding DB to
#
# Usage:
#   ./scripts/host/migrate-test-db-rename.sh           # ask for confirmation
#   ./scripts/host/migrate-test-db-rename.sh --yes     # non-interactive
#   ./scripts/host/migrate-test-db-rename.sh --dry-run # show planned actions only

set -euo pipefail

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-fk-encore-db-test}"
APP_CONTAINER="${APP_CONTAINER:-fk-encore-app-test}"
EMBEDDING_CONTAINER="${EMBEDDING_CONTAINER:-fk-encore-embedding-test}"
SOURCE_APP_DB="${SOURCE_APP_DB:-encore}"
SOURCE_EMBED_DB="${SOURCE_EMBED_DB:-embeddings}"
TARGET_APP_DB="${TARGET_APP_DB:-encore_test}"
TARGET_EMBED_DB="${TARGET_EMBED_DB:-embeddings_test}"

ASSUME_YES=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 64
      ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# psql wrapper — always connects to the `postgres` admin DB so we can
# operate on `encore` / `embeddings` without being attached to them.
psql_admin() {
  docker exec -i "$POSTGRES_CONTAINER" \
    psql -U postgres -d postgres -tA -v ON_ERROR_STOP=1 "$@"
}

# True iff a database with the given name exists in the cluster.
db_exists() {
  local name="$1"
  local result
  result=$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$name'")
  [ -n "$result" ]
}

# Drop every connection that's currently open against the given DB
# except our own (psql_admin is connected to `postgres`, not the
# source DB). Returns 0 even if nothing was open.
terminate_connections() {
  local name="$1"
  psql_admin <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$name' AND pid <> pg_backend_pid();
SQL
}

# ── Sanity checks ─────────────────────────────────────────────────────
if ! docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1; then
  red "Container '$POSTGRES_CONTAINER' not found. Set POSTGRES_CONTAINER if the name differs."
  exit 1
fi

bold "Plan"
echo "  Postgres container : $POSTGRES_CONTAINER"
echo "  App container      : $APP_CONTAINER"
echo "  Embedding container: $EMBEDDING_CONTAINER"
echo
echo "  $SOURCE_APP_DB     → $TARGET_APP_DB"
echo "  $SOURCE_EMBED_DB   → $TARGET_EMBED_DB"
echo

# Pre-check both source/target pairs.
RENAME_APP=true
RENAME_EMBED=true
for pair in "$SOURCE_APP_DB:$TARGET_APP_DB:RENAME_APP" \
            "$SOURCE_EMBED_DB:$TARGET_EMBED_DB:RENAME_EMBED"; do
  IFS=':' read -r src tgt flag <<<"$pair"
  if db_exists "$tgt"; then
    if db_exists "$src"; then
      red "ABORT: both '$src' AND '$tgt' exist. The script doesn't know which one to keep."
      red "Pick one manually, drop the other (\\c postgres; DROP DATABASE …), then re-run."
      exit 1
    fi
    yellow "  ↳ '$tgt' already exists and '$src' is gone — nothing to do for this pair."
    eval "$flag=false"
  elif ! db_exists "$src"; then
    red "ABORT: neither '$src' nor '$tgt' exists. Is the stack actually using these names?"
    exit 1
  fi
done

if [ "$RENAME_APP" = false ] && [ "$RENAME_EMBED" = false ]; then
  green "Both databases already use the target names. Nothing to do."
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  yellow "DRY-RUN — no changes made."
  exit 0
fi

# ── Confirmation ──────────────────────────────────────────────────────
if [ "$ASSUME_YES" != true ]; then
  echo
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in
    y|Y|yes) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# ── Stop dependent containers ─────────────────────────────────────────
bold "Stopping app + embedding containers so they release their DB connections."
for c in "$APP_CONTAINER" "$EMBEDDING_CONTAINER"; do
  if docker inspect "$c" >/dev/null 2>&1; then
    docker stop "$c" >/dev/null
    echo "  stopped: $c"
  else
    yellow "  skipped: $c (not found)"
  fi
done

# ── Terminate stray connections + rename ──────────────────────────────
do_rename() {
  local src="$1"
  local tgt="$2"
  bold "Renaming $src → $tgt"
  echo "  terminating any leftover connections on '$src'…"
  terminate_connections "$src" >/dev/null
  # Tiny pause: pg_terminate_backend sends SIGTERM but the backend
  # exit is asynchronous. 500ms is plenty in practice; ALTER DATABASE
  # otherwise occasionally races and reports "is being accessed".
  sleep 0.5
  psql_admin -c "ALTER DATABASE \"$src\" RENAME TO \"$tgt\";"
  green "  done."
}

if [ "$RENAME_APP" = true ]; then
  do_rename "$SOURCE_APP_DB" "$TARGET_APP_DB"
fi
if [ "$RENAME_EMBED" = true ]; then
  do_rename "$SOURCE_EMBED_DB" "$TARGET_EMBED_DB"
fi

# ── Verify ────────────────────────────────────────────────────────────
bold "Current databases:"
psql_admin -c "\\l" | awk 'NR<=3 || $1 ~ /^(encore|embeddings)/'

echo
green "Migration done."
cat <<'NEXT'

Next steps:
  1. Copy the test env template and adjust DEPLOY_DATA_ROOT + ports
     for your host:
        cp docker-compose.env.test.example .env.test
        $EDITOR .env.test
  2. Bring the stack back up against the new env-file:
        docker compose --env-file .env.test up -d
  3. Sanity-check that the app sees the renamed databases:
        docker logs -f fk-encore-app-test | grep -i 'database\|migration'
NEXT
