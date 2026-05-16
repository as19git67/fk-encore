# fk-encore-overpass-pbf
#
# Extends the upstream `wiktorn/overpass-api` image with `osmconvert`
# (Debian package `osmctools`) so the entrypoint's
# OVERPASS_PLANET_PREPROCESS can expand a Geofabrik `.osm.pbf` to OSM
# XML on the fly. The upstream image only handles `.osm.bz2`, which
# Geofabrik does not publish for sub-regional extracts
# (Regierungsbezirke etc.).
#
# Build:
#   docker build -t fk-encore-overpass-pbf:latest osm-admin/overpass-pbf/
#
# Use:
#   In docker-compose.yml, set on the fk-encore-app service:
#     OVERPASS_IMAGE: fk-encore-overpass-pbf:latest
#
# A follow-up slice will auto-build this image from the source tree via
# dockerode at first use; until then the host operator builds it once.

FROM wiktorn/overpass-api:latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends osmctools \
  && rm -rf /var/lib/apt/lists/*
