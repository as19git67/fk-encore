# Geo service: Node HTTP frontend + osm2pgsql/osmium binaries.
# Postgres+PostGIS run in a separate compose service (geo-db) so this
# image stays small and stateless.
FROM node:20-bookworm-slim

# osm2pgsql, osmium-tool, postgresql-client (for createdb/psql), curl
# for PBF download. ca-certificates lets us hit Geofabrik over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      osm2pgsql \
      osmium-tool \
      postgresql-client \
      curl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src

# Non-root runtime to match the rest of the stack (UID 568 = TrueNAS
# SCALE apps user). The PBF cache lives under /data which is
# bind/volume-mounted by compose.
RUN mkdir -p /data/pbf \
 && chown -R 568:568 /app /data
USER 568:568

ENV NODE_ENV=production \
    GEO_PORT=8080 \
    GEO_DATA_DIR=/data

EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
