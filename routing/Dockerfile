# Routing service: Valhalla, built from the same Geofabrik PBFs the geo
# service already downloads (docs/ios-urlaubsplanung.md §12, §24).
#
# One instance, one tile set: Valhalla serves a single tile directory,
# so every imported region goes into the same build. The entrypoint
# rebuilds when a PBF is newer than the tiles and serves what it has.
FROM ghcr.io/valhalla/valhalla:latest

# The runtime image ships the binaries and nothing else. The build
# helpers (valhalla_build_config, valhalla_build_extract) are Python
# scripts, the timezone build needs spatialite, the healthcheck curl.
# Without python3 the config step produced an empty file and every
# build tool failed on "could not parse json".
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python-is-python3 \
      curl \
      jq \
      spatialite-bin \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/fk-routing
RUN chmod +x /usr/local/bin/fk-routing \
 && mkdir -p /data /pbf \
 && chown -R 568:568 /data
USER 568:568
EXPOSE 8002
ENTRYPOINT ["/usr/local/bin/fk-routing"]
