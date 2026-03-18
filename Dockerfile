FROM node:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    nginx \
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
RUN npm ci --omit=dev

COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm --prefix frontend ci

COPY . .

RUN npm --prefix frontend run build

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /app/uploads/photos /app/data

ENV PHOTO_UPLOAD_DIR=/app/uploads/photos \
    BACKEND_PORT=4000 \
    PORT=8080 \
    RP_ID=localhost \
    RP_NAME="FK Encore App" \
    RP_ORIGIN=http://localhost:8080

EXPOSE 8080 4000

CMD ["/entrypoint.sh"]
