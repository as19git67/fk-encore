#!/usr/bin/env bash
#
# Nightly reset of the demo stack (documentation/plans/demodaten.md,
# "Demo deployment").
#
# Visitors of the demo create rows the demo register does not know, so
# removing the demo run is not enough: this script stops the demo stack,
# empties its database and file directories and starts it again. The app
# finds an untouched system at boot and, with DEMO_DATA set, loads the demo
# afresh (demo/boot.ts).
#
# The reset belongs at 18:00 America/Los_Angeles (03:00 in Germany, 02:00
# for a few weeks in spring and autumn). Host schedulers rarely know time
# zones, so run this script every hour (cron or a TrueNAS periodic task):
# it acts only in the hour 18 of Los Angeles and only once per day there.
#
#   0 * * * *  /path/to/fk-encore/scripts/host/demo-reset.sh /path/to/fk-encore/.env.demo
#
# Options:
#   --now      reset right away, whatever the time (still once per call)
#   --dry-run  say what would be emptied and stop
#
# It refuses to touch anything unless the env file
#   - sets DEMO_DATA (1, true, yes, on, full or small),
#   - sets a non-empty DEPLOY_NAME_SUFFIX, and
#   - sets an absolute DEPLOY_DATA_ROOT whose path contains "demo".
# Prod and test fail at least one of these.
#
# Kept: the model caches (llm_models, embedding_models, receipt-ocr-models),
# the OSM data (geo, geo-db, routing) and recap-music. Emptied: everything
# that holds rows or files of users.
#
# Exit codes:
#   0  reset done, or nothing to do at this hour
#   1  bad arguments or an env file that is not a demo
#   2  docker compose failed

set -euo pipefail

ENV_FILE=""
NOW=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --now) NOW=1 ;;
    --dry-run) DRY=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 1 ;;
    *) ENV_FILE="$arg" ;;
  esac
done

if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  echo "usage: $0 [--now] [--dry-run] /path/to/.env.demo" >&2
  exit 1
fi
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
COMPOSE_DIR="$(dirname "$ENV_FILE")"

# Reads KEY=value from the env file without sourcing it (no command
# substitution from a file on disk); the last assignment wins, like compose.
env_value() {
  local v
  v="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  v="${v%%#*}"
  v="$(echo "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  printf '%s' "$v"
}

DEMO_DATA="$(env_value DEMO_DATA | tr '[:upper:]' '[:lower:]')"
SUFFIX="$(env_value DEPLOY_NAME_SUFFIX)"
DATA_ROOT="$(env_value DEPLOY_DATA_ROOT)"

case "$DEMO_DATA" in
  1|true|yes|on|full|small) ;;
  *) echo "refusing: $ENV_FILE does not set DEMO_DATA, so it is no demo stack" >&2; exit 1 ;;
esac
if [[ -z "$SUFFIX" ]]; then
  echo "refusing: DEPLOY_NAME_SUFFIX is empty (that is the prod stack)" >&2
  exit 1
fi
if [[ "$DATA_ROOT" != /* || "$DATA_ROOT" != *demo* || "$DATA_ROOT" == *..* ]]; then
  echo "refusing: DEPLOY_DATA_ROOT must be an absolute path containing \"demo\" (is \"$DATA_ROOT\")" >&2
  exit 1
fi

STAMP="$DATA_ROOT/.demo-reset-day"
TODAY_LA="$(TZ=America/Los_Angeles date +%F)"
if [[ $NOW -eq 0 ]]; then
  if [[ "$(TZ=America/Los_Angeles date +%H)" != "18" ]]; then
    exit 0
  fi
  if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$TODAY_LA" ]]; then
    exit 0
  fi
fi

# The directories under DEPLOY_DATA_ROOT that hold users' rows and files
# (docker-compose.volumes.yml).
EMPTY=(pgdata photos thumbnails backup documents documents-inbox documents-source finance-export taxonomy-out)

if [[ $DRY -eq 1 ]]; then
  echo "would stop the stack of $ENV_FILE, empty these directories and start it again:"
  for d in "${EMPTY[@]}"; do echo "  $DATA_ROOT/$d"; done
  exit 0
fi

echo "$(date -Is) demo reset: stopping the stack"
(cd "$COMPOSE_DIR" && docker compose --env-file "$ENV_FILE" down) || exit 2

for d in "${EMPTY[@]}"; do
  dir="$DATA_ROOT/$d"
  [[ -d "$dir" ]] || continue
  echo "$(date -Is) demo reset: emptying $dir"
  find "$dir" -mindepth 1 -delete
done

echo "$(date -Is) demo reset: starting the stack; the app loads the demo at boot"
(cd "$COMPOSE_DIR" && docker compose --env-file "$ENV_FILE" up -d) || exit 2
echo "$TODAY_LA" > "$STAMP"
echo "$(date -Is) demo reset: done"
