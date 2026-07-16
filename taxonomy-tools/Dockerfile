# ── Stage 1: Python dependencies ────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: runtime image ─────────────────────────────────────────────────
FROM python:3.12-slim-bookworm

# Node.js 20 for diagnose.mjs (the only Node-based script).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# TrueNAS SCALE "apps" user (568:568) — same as every other sidecar.
RUN groupadd --gid 568 apps \
    && useradd --uid 568 --gid 568 --create-home --shell /bin/bash apps

WORKDIR /app

COPY --from=builder /install /usr/local

# Node dependency: pg (for diagnose.mjs). Installed at build time so the
# runtime image needs no npm/network access.
COPY package.json ./
RUN npm install --omit=dev && chown -R 568:568 /app/node_modules

# The taxonomy scripts live under /app/scripts/taxonomy/ so that
# _common.py's REPO_ROOT (Path(__file__).parents[2]) resolves to /app.
# The TS source files the scripts parse at runtime are placed under
# /app/documents/ to match the REPO_ROOT-relative import paths.
COPY scripts/taxonomy/ /app/scripts/taxonomy/
COPY ts-sources/documents/ /app/documents/

COPY main.py ./

RUN mkdir -p /app/scripts/taxonomy/out \
    && chown -R 568:568 /app

ENV SCRIPTS_DIR=/app/scripts/taxonomy \
    TS_SOURCES_DIR=/app/ts-sources \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

USER 568:568

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
