#!/usr/bin/env bash
#
# Tear down osm-admin's runtime-managed Nominatim + Overpass containers
# for a given fk-encore deployment, so that `docker compose down` can
# remove the OSM bridge network afterwards.
#
# WHY THIS EXISTS
#
# osm-admin starts per-region Nominatim/Overpass containers at runtime
# via dockerode — they are NOT part of docker-compose.yml. That means
# `docker compose down` doesn't know about them, leaves them running,
# and then fails to remove the OSM network with:
#
#   Network test-osm-net  Resource is still in use
#
# This script finds those leftover region containers by name pattern
# (driven by the deployment's OSM name prefix) and stops + removes them.
# After it has run, `docker compose down` succeeds.
#
# Usage:
#   ./scripts/host/osm-down.sh                  # prod stack (no prefix)
#   ./scripts/host/osm-down.sh test-            # test stack
#   ./scripts/host/osm-down.sh --prefix test-   # same, explicit
#   ./scripts/host/osm-down.sh --dry-run        # show what would happen
#   ./scripts/host/osm-down.sh --yes test-      # non-interactive
#
# The prefix MUST match DEPLOY_OSM_NAME_PREFIX in your env-file (default
# empty for production, "test-" in docker-compose.env.test.example).
#
# Idempotent: if no matching containers exist, the script just reports
# that and exits 0.

set -euo pipefail

PREFIX=""
ASSUME_YES=false
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    -*)
      echo "unknown option: $1" >&2
      exit 64
      ;;
    *)
      # First positional arg = prefix.
      PREFIX="$1"
      shift
      ;;
  esac
done

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }

# Collect matching containers. The two roles osm-admin spawns are
# `nominatim` and `overpass`, named `<prefix><role>-<region-slug>`. We
# anchor the filter with `^` so a prefix of "" doesn't accidentally
# match containers named `test-nominatim-foo` from a sibling stack.
if ! docker info >/dev/null 2>&1; then
  echo "docker daemon not reachable — is the host's docker service up?" >&2
  exit 1
fi
mapfile -t CONTAINERS < <(
  docker ps -a \
    --filter "name=^${PREFIX}nominatim-" \
    --filter "name=^${PREFIX}overpass-" \
    --format '{{.Names}}' \
    | sort
)

bold "Plan"
echo "  Prefix : '${PREFIX}'"
if [ "${#CONTAINERS[@]}" -eq 0 ]; then
  green "  No region containers found for this prefix — nothing to do."
  exit 0
fi
echo "  Targets:"
printf '    %s\n' "${CONTAINERS[@]}"
echo

if [ "$DRY_RUN" = true ]; then
  yellow "DRY-RUN — no changes made."
  exit 0
fi

if [ "$ASSUME_YES" != true ]; then
  read -r -p "Stop + remove these containers? [y/N] " ans
  case "$ans" in
    y|Y|yes) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# `docker rm -f` stops then removes in one shot, and is a no-op against
# a name that vanished between the listing and the call.
docker rm -f "${CONTAINERS[@]}" >/dev/null
green "Removed ${#CONTAINERS[@]} container(s)."

cat <<'NEXT'

Next step: bring the stack down.
  docker compose --env-file .env.test down   # for the test stack
  docker compose down                         # for prod
NEXT
