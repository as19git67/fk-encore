#!/usr/bin/env bash
# Build Valhalla tiles from the PBFs in /pbf, then serve them.
#
# The PBFs are the geo service's (`geo_data/pbf`, mounted read-only):
# a region imported for spots is a region routable by the same file,
# and deleting the region takes both away. Tiles live in /data.
#
# Rebuilds are decided by a stamp: the list of PBFs with their sizes
# and mtimes at the last build. A new or refreshed extract changes the
# stamp, and the next start builds again. There is no rebuild without a
# restart — the app reads /status?verbose=true and says when the tiles
# are older than the newest region (§15.3), it does not pretend.
set -euo pipefail

PBF_DIR=${PBF_DIR:-/pbf}
DATA_DIR=${DATA_DIR:-/data}
CONFIG=$DATA_DIR/valhalla.json
TILE_DIR=$DATA_DIR/tiles
STAMP=$DATA_DIR/tiles.stamp
PORT=${ROUTING_PORT:-8002}

stamp() {
  # name, size, mtime per PBF — enough to notice a refreshed extract.
  find "$PBF_DIR" -maxdepth 1 -name '*.pbf' -printf '%f %s %T@\n' 2>/dev/null | sort
}

pbfs() {
  find "$PBF_DIR" -maxdepth 1 -name '*.pbf' 2>/dev/null | sort
}

# No extracts yet: nothing to serve. Wait for the first import rather
# than exit, so compose does not restart-loop and the status stays
# readable as "no tiles".
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
    --service-limits-auto-max-matrix-locations 200 \
    --service-limits-bicycle-max-matrix-locations 200 \
    --service-limits-pedestrian-max-matrix-locations 200 \
    --httpd-service-listen "tcp://*:${PORT}" \
    > "$CONFIG.new"; then
  echo "fk-routing: valhalla_build_config failed" >&2
  exit 1
fi
if ! jq -e . "$CONFIG.new" >/dev/null; then
  echo "fk-routing: valhalla_build_config wrote no JSON" >&2
  exit 1
fi
mv "$CONFIG.new" "$CONFIG"

if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$(stamp)" ]; then
  echo "fk-routing: building tiles from $(pbfs | wc -l) extract(s)"
  # Admin and timezone databases once; they are cheap next to the tiles
  # and make turn restrictions across borders and time-dependent
  # routing (GTFS, later) work.
  [ -f "$DATA_DIR/admins.sqlite" ] || valhalla_build_admins -c "$CONFIG" $(pbfs) || true
  [ -f "$DATA_DIR/timezones.sqlite" ] || valhalla_build_timezones > "$DATA_DIR/timezones.sqlite" || true
  rm -rf "$TILE_DIR"/* "$DATA_DIR/tiles.tar"
  valhalla_build_tiles -c "$CONFIG" $(pbfs)
  valhalla_build_extract -c "$CONFIG" -v || true
  stamp > "$STAMP"
  echo "fk-routing: tiles built"
fi

exec valhalla_service "$CONFIG" 1
