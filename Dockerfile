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

RUN curl -L https://encore.dev/install.sh | bash
ENV PATH="/root/.encore/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev --omit=optional

COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm --prefix frontend install

COPY . .

RUN npm --prefix frontend run build

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /mnt/data/photos /app/data

ENV DB_TYPE=postgres \
    POSTGRES_HOST=localhost \
    POSTGRES_PORT=5432 \
    POSTGRES_USER=postgres \
    POSTGRES_PASSWORD=postgres \
    POSTGRES_DATABASE=fk_encore \
    PHOTO_UPLOAD_DIR=/mnt/data/photos \
    PORT=8080 \
    RP_ID=localhost \
    RP_NAME="Vivanty App" \
    RP_ORIGIN=http://localhost:8080 \
    ENABLE_LOCAL_FACES=true \
    INSIGHTFACE_SERVICE_URL=http://localhost:8000 \
    FACE_DISTANCE_THRESHOLD=0.45

EXPOSE 8080

CMD ["/entrypoint.sh"]
