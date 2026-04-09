FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root "apps" user matching TrueNAS SCALE's built-in apps user
# (UID/GID 568). The node base image already ships a "node" group with GID
# 1000, so 568 does not clash.
RUN groupadd -g 568 apps \
    && useradd -u 568 -g 568 -m -s /bin/bash apps

# Install the Encore CLI into a shared, non-root location so the apps user
# can execute it.
RUN curl -L https://encore.dev/install.sh | bash \
    && mv /root/.encore /opt/encore \
    && chmod -R a+rX /opt/encore
ENV PATH="/opt/encore/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev --omit=optional

COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm --prefix frontend install --legacy-peer-deps

COPY . .

RUN npm --prefix frontend run build

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /mnt/data/photos /mnt/data/thumbnails /app/data \
    && chown -R 568:568 /app /mnt/data /home/apps

ENV DB_TYPE=postgres \
    POSTGRES_HOST=localhost \
    POSTGRES_PORT=5432 \
    POSTGRES_USER=postgres \
    POSTGRES_PASSWORD= \
    POSTGRES_DATABASE=fk_encore \
    PHOTO_UPLOAD_DIR=/mnt/data/photos \
    PHOTO_THUMBNAIL_DIR=/mnt/data/thumbnails \
    PORT=8080 \
    RP_ID=localhost \
    RP_NAME="Vivanty App" \
    RP_ORIGIN=http://localhost:8080 \
    ENABLE_LOCAL_FACES=true \
    INSIGHTFACE_SERVICE_URL=http://localhost:8000 \
    FACE_DISTANCE_THRESHOLD=0.45 \
    HOME=/home/apps

ARG BUILD_NUMBER=dev
ENV APP_BUILD_NUMBER=${BUILD_NUMBER}

EXPOSE 8080

USER 568:568

CMD ["/entrypoint.sh"]
