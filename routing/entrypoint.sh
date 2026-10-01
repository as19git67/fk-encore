#!/usr/bin/env bash
# Build Valhalla tiles from the PBFs in /pbf, then serve them.
#
# The PBFs are the geo service's (`geo_data/pbf`, mounted read-only):
# a region imported for spots is a region routable by the same file.
# Deleting a region deletes its extract (geo/src/pbf-cache.ts), and the
# geo service clears extracts whose region is gone. Tiles live in /data.
#
# Rebuilds are decided by a stamp: the list of PBFs with their sizes
# and mtimes at the last build. While serving, the stamp is compared
# every WATCH_INTERVAL seconds; once a changed set has stayed the same
# for one more interval (a download in progress keeps changing), the
# service stops and the container exits, compose restarts it, and the
# start builds again — from scratch: tiles, admin database and all, so
# nothing of a deleted extract survives. No extracts at all: the old
# tiles are removed and the container waits for the first import.
set -euo pipefail

PBF_DIR=${PBF_DIR:-/pbf}
DATA_DIR=${DATA_DIR:-/data}
CONFIG=$DATA_DIR/valhalla.json
TILE_DIR=$DATA_DIR/tiles
STAMP=$DATA_DIR/tiles.stamp
PORT=${ROUTING_PORT:-8002}

MERGED=$DATA_DIR/merged.osm.pbf
WATCH_INTERVAL=${WATCH_INTERVAL:-600}

stamp() {
  # name, size, mtime per PBF — enough to notice a new, refreshed or
  # deleted extract. A download in progress is a .part file, not a .pbf.
  find "$PBF_DIR" -maxdepth 1 -name '*.pbf' -printf '%f %s %T@\n' 2>/dev/null | sort
}

pbfs() {
  find "$PBF_DIR" -maxdepth 1 -name '*.pbf' 2>/dev/null | sort
}

# No extracts: nothing to serve, and nothing old either. Tiles of
# extracts that are gone are removed, then the container waits for the
# first import rather than exit, so compose does not restart-loop and
# the status reads "no tiles".
if [ -z "$(pbfs)" ]; then
  rm -rf "$DATA_DIR/tiles" "$DATA_DIR/tiles.tar" "$DATA_DIR/admins.sqlite" "$STAMP" "$MERGED"
fi
while [ -z "$(pbfs)" ]; do
  echo "fk-routing: no PBF in $PBF_DIR yet — waiting for the first region import"
  sleep 300
done

mkdir -p "$TILE_DIR"
# Written fresh on every start, into a temporary file first: a redirect
# creates its target before the command runs, and a failing
# valhalla_build_config once left an empty config that every later
# start took for a finished one. Generating it is cheap; a config that
# is not JSON stops the container here, with the tool's own error, and
# never reaches the tile build.
if ! valhalla_build_config \
    --mjolnir-tile-dir "$TILE_DIR" \
    --mjolnir-tile-extract "$DATA_DIR/tiles.tar" \
    --mjolnir-timezone "$DATA_DIR/timezones.sqlite" \
    --mjolnir-admin "$DATA_DIR/admins.sqlite" \
    --service-limits-status-allow-verbose true \
    --httpd-service-listen "tcp://*:${PORT}" \
    > "$CONFIG.new"; then
  echo "fk-routing: valhalla_build_config failed" >&2
  exit 1
fi
# The matrix limits are set in the finished JSON rather than by flag:
# the flag names follow the config keys, and those changed between
# Valhalla versions (max_matrix_locations became
# max_matrix_location_pairs). Whichever of the two this version has is
# raised; a key it does not have is left alone. The planner asks one
# matrix of up to 120 points per day (trip-planner/travel-table.ts),
# which is 14 400 pairs.
if ! jq '
    .service_limits |= with_entries(
      if (.value | type) == "object" then
        .value |= (
          (if has("max_matrix_location_pairs") then .max_matrix_location_pairs = 15000 else . end)
          | (if has("max_matrix_locations") then .max_matrix_locations = 200 else . end)
        )
      else . end)
  ' "$CONFIG.new" > "$CONFIG.tmp"; then
  echo "fk-routing: valhalla_build_config wrote no usable JSON" >&2
  exit 1
fi
mv "$CONFIG.tmp" "$CONFIG"
rm -f "$CONFIG.new"

if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$(stamp)" ]; then
  # What is built is what was there when the build began; a file that
  # arrives during it changes the stamp and triggers the next build.
  building=$(stamp)
  mapfile -t inputs < <(pbfs)
  echo "fk-routing: building tiles from ${#inputs[@]} extract(s)"
  # From scratch: tiles and the admin database of a set that is gone
  # must not outlive it. The timezone database does not depend on the
  # extracts and is kept.
  rm -rf "$TILE_DIR"/* "$DATA_DIR/tiles.tar" "$DATA_DIR/admins.sqlite" "$STAMP" "$MERGED"
  # Overlapping extracts (Great Britain and England, a country and its
  # states) share their nodes and ways; handed to Valhalla side by side
  # they become duplicate edges. osmium merges them into one file and
  # keeps each object once.
  if [ "${#inputs[@]}" -gt 1 ]; then
    osmium merge --overwrite -o "$MERGED" "${inputs[@]}"
    source_pbf=$MERGED
  else
    source_pbf=${inputs[0]}
  fi
  valhalla_build_admins -c "$CONFIG" "$source_pbf" || true
  [ -f "$DATA_DIR/timezones.sqlite" ] || valhalla_build_timezones > "$DATA_DIR/timezones.sqlite" || true
  valhalla_build_tiles -c "$CONFIG" "$source_pbf"
  valhalla_build_extract -c "$CONFIG" -v || true
  rm -f "$MERGED"
  echo "$building" > "$STAMP"
  echo "fk-routing: tiles built"
fi

valhalla_service "$CONFIG" 1 &
service=$!
trap 'kill -TERM "$service" 2>/dev/null; wait "$service"; exit 0' TERM INT

# Watch the extracts. A changed set must be seen twice in a row before
# the rebuild starts, so a download or a refresh in progress is not
# built half-done.
pending=""
while kill -0 "$service" 2>/dev/null; do
  sleep "$WATCH_INTERVAL" &
  wait $! || true
  current=$(stamp)
  if [ "$current" = "$(cat "$STAMP")" ]; then
    pending=""
  elif [ "$current" = "$pending" ]; then
    echo "fk-routing: extracts changed — restarting to rebuild the tiles"
    kill -TERM "$service" 2>/dev/null || true
    wait "$service" || true
    exit 0
  else
    pending=$current
  fi
done

wait "$service"
