#!/usr/bin/env bash
#
# Puts a fresh copy of production under the test stack
# (documentation/plans/dev-system.md, "Refresh"; DEPLOYMENT.md › "Test stack").
#
# Runs on the TrueNAS host as root, weekly (after the nightly backup) and by
# hand whenever a newer copy is wanted:
#
#   test-refresh.sh [--dry-run] [--snapshot <label>] /path/to/test/.env
#
# Steps:
#   1. stop the test stack
#   2. find the newest daily-* snapshot of PROD_DATASET (or --snapshot)
#   3. destroy TEST_DATASET — only if every dataset in it is a clone of a
#      snapshot of PROD_DATASET; anything else is never destroyed
#   4. clone the snapshot to TEST_DATASET, and each child dataset to the
#      matching child (a clone is not recursive)
#   5. remove from the clone what belongs to prod alone: prod's env files at
#      the top of the dataset, the dumps and the backup token
#   6. start postgres and geo-db on the clone, set their passwords to the
#      ones in the test env file, run test-scrub.sql on the main database
#   7. start the whole stack; the app migrates the copy to its image
#
# The snapshot is atomic, so Postgres starts on the clone like after a power
# cut and replays its WAL. A clone costs no space until either side changes,
# and test may delete and rewrite whatever it likes: prod never sees it.
#
# Call it from prod's backup/host-scripts/ (the image seeds it there on every
# start, next to test-scrub.sql), never from inside the test copy: the
# refresh destroys that copy. It refuses to run unless the env file
#   - sets APP_ENVIRONMENT=dev,
#   - sets a DEPLOY_NAME_SUFFIX containing "test",
#   - sets PROD_DATASET and TEST_DATASET, TEST_DATASET containing "test",
#     different from PROD_DATASET and not inside it,
#   - sets an absolute DEPLOY_DATA_ROOT inside the mountpoint of TEST_DATASET.
#
# Exit codes:
#   0  done (or --dry-run)
#   1  bad arguments or an env file that is not the test stack's
#   2  docker compose failed
#   3  zfs failed
#   4  the copy is unusable (no data directory, no database) or the scrub failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

ENV_FILE=""
DRY=0
SNAPSHOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --snapshot) SNAPSHOT="${2:-}"; shift ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) ENV_FILE="$1" ;;
  esac
  shift
done

if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  echo "usage: $0 [--dry-run] [--snapshot <label>] /path/to/test/.env" >&2
  exit 1
fi
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
COMPOSE_DIR="$(dirname "$ENV_FILE")"

log() { printf '[test-refresh %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
refuse() { echo "refusing: $*" >&2; exit 1; }

# Reads KEY=value from the env file without sourcing it (no command
# substitution from a file on disk); the last assignment wins, like compose.
env_value() {
  local v
  v="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  v="${v%%#*}"
  v="$(echo "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  printf '%s' "$v"
}

APP_ENVIRONMENT="$(env_value APP_ENVIRONMENT)"
SUFFIX="$(env_value DEPLOY_NAME_SUFFIX)"
PROD_DATASET="$(env_value PROD_DATASET)"
TEST_DATASET="$(env_value TEST_DATASET)"
DATA_ROOT="$(env_value DEPLOY_DATA_ROOT)"
PG_DATABASE="$(env_value DEPLOY_PG_DATABASE)"
PG_DATABASE="${PG_DATABASE:-encore}"
PG_PASSWORD="$(env_value POSTGRES_PASSWORD)"
PG_PASSWORD="${PG_PASSWORD:-postgres}"
GEO_PASSWORD="$(env_value GEO_DB_PASSWORD)"
GEO_PASSWORD="${GEO_PASSWORD:-postgres}"

# -- the env file must be the test stack's ---------------------------------
[[ "$APP_ENVIRONMENT" == "dev" ]] || refuse "$ENV_FILE does not set APP_ENVIRONMENT=dev, so it is not the test stack on a copy of prod"
[[ -n "$SUFFIX" ]] || refuse "DEPLOY_NAME_SUFFIX is empty (that is the prod stack)"
[[ "$SUFFIX" == *test* ]] || refuse "DEPLOY_NAME_SUFFIX must contain \"test\" (is \"$SUFFIX\")"
[[ -n "$PROD_DATASET" && -n "$TEST_DATASET" ]] || refuse "PROD_DATASET and TEST_DATASET must both be set"
for ds in "$PROD_DATASET" "$TEST_DATASET"; do
  [[ "$ds" != /* && "$ds" != *..* && "$ds" != *@* && "$ds" != */ && "$ds" =~ ^[A-Za-z0-9_./:-]+$ ]] \
    || refuse "\"$ds\" is not a dataset name (pool/path, no mountpoint)"
done
[[ "$TEST_DATASET" == *test* ]] || refuse "TEST_DATASET must contain \"test\" (is \"$TEST_DATASET\")"
[[ "$TEST_DATASET" != "$PROD_DATASET" ]] || refuse "TEST_DATASET is PROD_DATASET"
[[ "$TEST_DATASET" != "$PROD_DATASET"/* ]] || refuse "TEST_DATASET lies inside PROD_DATASET"
[[ "$PROD_DATASET" != "$TEST_DATASET"/* ]] || refuse "PROD_DATASET lies inside TEST_DATASET"
[[ "$TEST_DATASET" == */* ]] || refuse "TEST_DATASET must not be a pool's root dataset"
[[ "$DATA_ROOT" == /* && "$DATA_ROOT" != *..* ]] || refuse "DEPLOY_DATA_ROOT must be an absolute path (is \"$DATA_ROOT\")"
[[ "$PG_DATABASE" =~ ^[A-Za-z0-9_]+$ ]] || refuse "DEPLOY_PG_DATABASE \"$PG_DATABASE\" is not a plain database name"
[[ -z "$SNAPSHOT" || "$SNAPSHOT" =~ ^[A-Za-z0-9_.:-]+$ ]] || refuse "--snapshot takes a label like daily-2026-11-14_01-30"
[[ -r "$SCRIPT_DIR/test-scrub.sql" ]] || refuse "test-scrub.sql is missing next to this script ($SCRIPT_DIR)"

for bin in zfs docker; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FATAL: $bin not found on PATH — this script must run on the host" >&2; exit 1; }
done

compose() { (cd "$COMPOSE_DIR" && docker compose --env-file "$ENV_FILE" "$@"); }

# -- where the copy will be -----------------------------------------------
zfs list -H -o name "$PROD_DATASET" >/dev/null 2>&1 || refuse "PROD_DATASET $PROD_DATASET does not exist"
TEST_PARENT="${TEST_DATASET%/*}"
zfs list -H -o name "$TEST_PARENT" >/dev/null 2>&1 || refuse "the parent dataset $TEST_PARENT of TEST_DATASET does not exist"

TEST_EXISTS=0
if zfs list -H -o name "$TEST_DATASET" >/dev/null 2>&1; then
  TEST_EXISTS=1
  TEST_MNT="$(zfs get -H -o value mountpoint "$TEST_DATASET")"
else
  TEST_MNT="$(zfs get -H -o value mountpoint "$TEST_PARENT")/${TEST_DATASET##*/}"
fi
[[ "$TEST_MNT" == /* ]] || refuse "TEST_DATASET has no mountpoint (is \"$TEST_MNT\")"
[[ "$DATA_ROOT" == "$TEST_MNT" || "$DATA_ROOT" == "$TEST_MNT"/* ]] \
  || refuse "DEPLOY_DATA_ROOT $DATA_ROOT is not inside the mountpoint $TEST_MNT of TEST_DATASET"
[[ "$SCRIPT_PATH" != "$TEST_MNT"/* ]] \
  || refuse "this script runs from inside the copy it would destroy; call it from prod's backup/host-scripts/"
[[ "$ENV_FILE" != "$TEST_MNT"/* ]] \
  || refuse "the env file lies inside the copy it would destroy; keep it next to the test stack's compose files"

# Everything in TEST_DATASET must be a clone of a snapshot of PROD_DATASET —
# a dataset that holds data of its own is never destroyed.
if [[ $TEST_EXISTS -eq 1 ]]; then
  while IFS=$'\t' read -r name origin; do
    [[ -z "$name" ]] && continue
    if [[ "$origin" != "$PROD_DATASET"@* && "$origin" != "$PROD_DATASET"/*@* ]]; then
      refuse "$name is not a clone of a snapshot of $PROD_DATASET (origin \"$origin\"); move its data away or destroy it by hand"
    fi
  done < <(zfs list -H -r -o name,origin "$TEST_DATASET")
fi

# -- which snapshot ---------------------------------------------------------
if [[ -z "$SNAPSHOT" ]]; then
  SNAPSHOT="$(zfs list -H -p -d 1 -t snapshot -o name,creation -s creation "$PROD_DATASET" \
    | awk -F'\t' '{ split($1, a, "@"); if (a[2] ~ /^daily-/) last = a[2] } END { print last }')"
  [[ -n "$SNAPSHOT" ]] || { echo "FATAL: $PROD_DATASET has no daily-* snapshot — has the nightly backup run?" >&2; exit 3; }
fi
zfs list -H -o name "$PROD_DATASET@$SNAPSHOT" >/dev/null 2>&1 \
  || { echo "FATAL: snapshot $PROD_DATASET@$SNAPSHOT does not exist" >&2; exit 3; }

mapfile -t PROD_TREE < <(zfs list -H -r -o name "$PROD_DATASET")

if [[ $DRY -eq 1 ]]; then
  echo "would stop the stack of $ENV_FILE"
  [[ $TEST_EXISTS -eq 1 ]] && echo "would destroy $TEST_DATASET (and every clone inside it)"
  for ds in "${PROD_TREE[@]}"; do
    if zfs list -H -o name "$ds@$SNAPSHOT" >/dev/null 2>&1; then
      echo "would clone $ds@$SNAPSHOT to $TEST_DATASET${ds#"$PROD_DATASET"}"
    else
      echo "would skip $ds (no snapshot $SNAPSHOT)"
    fi
  done
  echo "would remove $TEST_MNT/.env*, $DATA_ROOT/backup/*.dump and $DATA_ROOT/backup/host-scripts/backup-token"
  echo "would set the passwords of postgres and geo-db and scrub database $PG_DATABASE"
  echo "would start the stack on the copy of $SNAPSHOT"
  exit 0
fi

# -- 1. stop -----------------------------------------------------------------
log "stopping the test stack"
compose down || exit 2

# -- 2./3. replace the clone ------------------------------------------------
if [[ $TEST_EXISTS -eq 1 ]]; then
  log "destroying the previous copy $TEST_DATASET"
  zfs destroy -r "$TEST_DATASET" || exit 3
fi

# -- 4. clone ----------------------------------------------------------------
# `zfs list -r` names a parent before its children, so each clone's parent
# exists by the time it is created.
for ds in "${PROD_TREE[@]}"; do
  target="$TEST_DATASET${ds#"$PROD_DATASET"}"
  if ! zfs list -H -o name "$ds@$SNAPSHOT" >/dev/null 2>&1; then
    log "WARN: $ds has no snapshot $SNAPSHOT (created after it?), skipped"
    continue
  fi
  log "cloning $ds@$SNAPSHOT to $target"
  zfs clone "$ds@$SNAPSHOT" "$target" || exit 3
done

TEST_MNT="$(zfs get -H -o value mountpoint "$TEST_DATASET")"
if [[ ! -d "$DATA_ROOT/pgdata" ]]; then
  echo "FATAL: $DATA_ROOT/pgdata does not exist in the copy — does DEPLOY_DATA_ROOT name the same sub-path as prod's?" >&2
  echo "the copy is at $TEST_MNT: $(ls -A "$TEST_MNT" | tr '\n' ' ')" >&2
  exit 4
fi

# -- 5. remove what belongs to prod alone -----------------------------------
log "removing prod's env files, dumps and backup token from the copy"
find "$TEST_MNT" -maxdepth 1 -type f -name '.env*' -delete
if [[ -d "$DATA_ROOT/backup" ]]; then
  find "$DATA_ROOT/backup" -maxdepth 1 -type f -name '*.dump' -delete
  rm -f "$DATA_ROOT/backup/host-scripts/backup-token"
fi

# -- 6. passwords and scrub ---------------------------------------------------
log "starting postgres and geo-db on the copy"
compose up -d --wait postgres geo-db || exit 2

# The clusters carry prod's passwords. The local socket in the container
# needs none, so they are set to the test stack's own. The password goes in
# through the environment of `exec`, never on a command line of the host.
set_password() {
  local service="$1" password="$2"
  printf "ALTER USER postgres PASSWORD :'pw';\n" \
    | compose exec -T -e FK_PW="$password" "$service" \
        sh -c 'exec psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres -v pw="$FK_PW"'
}
log "setting the passwords of postgres and geo-db"
set_password postgres "$PG_PASSWORD" || exit 4
set_password geo-db "$GEO_PASSWORD" || exit 4

has_db="$(printf "SELECT 1 FROM pg_database WHERE datname = '%s';\n" "$PG_DATABASE" \
  | compose exec -T postgres psql -tA -U postgres -d postgres)" || exit 4
if [[ "$(echo "$has_db" | tr -d '[:space:]')" != "1" ]]; then
  echo "FATAL: the copy has no database $PG_DATABASE — set DEPLOY_PG_DATABASE (and DEPLOY_PG_EMBEDDINGS_DATABASE) to prod's names" >&2
  exit 4
fi

log "scrubbing $PG_DATABASE"
compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U postgres -d "$PG_DATABASE" \
  < "$SCRIPT_DIR/test-scrub.sql" || exit 4

printf '%s\t%s\n' "$PROD_DATASET@$SNAPSHOT" "$(date -u +%FT%TZ)" > "$DATA_ROOT/.test-copy"

# -- 7. start ------------------------------------------------------------------
log "starting the test stack on the copy of $SNAPSHOT"
compose up -d || exit 2
log "done: test runs on $PROD_DATASET@$SNAPSHOT"
