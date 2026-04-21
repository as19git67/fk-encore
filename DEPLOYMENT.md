# FK Encore – Deployment with Docker Compose

## Requirements

- Docker (with Compose v2)
- At least **8 GB of RAM** (the ML models for face recognition and embeddings
  need memory)

## Quick start

```bash
# 1. Create the configuration
cp docker-compose.env.example .env

# 2. Adjust .env (at minimum change ADMIN_PASSWORD!)
nano .env

# 3. Start
docker compose up -d

# 4. Check the logs
docker compose logs -f
```

The app is then reachable at **http://localhost:8080**.

## Services

| Service              | Description                                | Internal port | Default host port  |
|----------------------|--------------------------------------------|---------------|--------------------|
| `app`                | Encore.ts main application (frontend + API) | 8080          | 8080               |
| `insightface`        | Face recognition (InsightFace/buffalo_l)   | 8000          | – (internal only)  |
| `embedding_service`  | Photo embeddings (CLIP + DINOv2)           | 8000          | – (internal only)  |
| `embedding_postgres` | PostgreSQL with pgvector for embeddings    | 5432          | – (internal only)  |

The ML services (insightface, embedding_service) are only reachable
internally and not exposed to the outside.

## Configuration

### Required variables

| Variable          | Description |
|-------------------|-------------|
| `ADMIN_PASSWORD`  | Password for the initial admin account |

### Optional variables

| Variable                  | Default                  | Description |
|---------------------------|--------------------------|-------------|
| `APP_PORT`                | `8080`                   | Host port for the app |
| `ADMIN_EMAIL`             | `admin@example.com`      | Email of the admin account |
| `ADMIN_NAME`              | `Admin`                  | Name of the admin account |
| `RP_ID`                   | `localhost`              | WebAuthn domain (without protocol/port) |
| `RP_ORIGIN`               | `http://localhost:8080`  | WebAuthn origin (full URL) |
| `DB_TYPE`                 | `sqlite`                 | Database type (`sqlite` or `postgres`) |
| `ENABLE_LOCAL_FACES`      | `true`                   | Enable face recognition |
| `FACE_DISTANCE_THRESHOLD` | `0.42`                   | Threshold for face matching (lower = stricter) |
| `CLIP_MODEL_NAME`         | `ViT-B-32`               | OpenCLIP model |
| `CLIP_PRETRAINED`         | `openai`                 | Pretrained weights |
| `DINO_MODEL_NAME`         | `facebook/dinov2-base`   | DINOv2 model |
| `EMBEDDING_DB_PASSWORD`   | `postgres`               | Password for the embedding database |

### Example: production setup behind a reverse proxy

```env
APP_PORT=8080
ADMIN_EMAIL=admin@my-domain.com
ADMIN_NAME=Administrator
ADMIN_PASSWORD=a-strong-password-here
RP_ID=photos.my-domain.com
RP_NAME=Family Photos
RP_ORIGIN=https://photos.my-domain.com
EMBEDDING_DB_PASSWORD=another-password
```

### Web Push notifications (optional)

Push notifications for feed events (album shares, comments, new photos in
shared albums) are delivered via the browser's Push API and require a
VAPID keypair. Without the keys the feature silently stays off:
`/push/vapid-public-key` reports `{ enabled: false }`, the Profile page
explains "Push is not configured on the server", and feed fan-out skips
the push leg entirely.

1. Generate a VAPID keypair once (any machine, throw-away Node):

   ```bash
   npx web-push generate-vapid-keys
   ```

2. Set the three secrets in your environment. With Encore Cloud:

   ```bash
   encore secret set --type prod VapidPublicKey
   encore secret set --type prod VapidPrivateKey
   encore secret set --type prod VapidSubject   # e.g. mailto:admin@my-domain.com
   ```

   For self-hosted deployments put the same values into
   `.secrets.local.cue` (local dev) or the runtime secret mechanism
   your infrastructure uses — the keys map to
   `secret("VapidPublicKey")`, `secret("VapidPrivateKey")` and
   `secret("VapidSubject")` in `push/push.service.ts`.

3. Restart the app. Users can then opt in per device under
   **Profil → Benachrichtigungen**.

See `docs/push-notifications.md` for architecture, subscription
lifecycle and troubleshooting.

## Data & volumes

| Volume             | Contents                                   |
|--------------------|--------------------------------------------|
| `app-data`         | SQLite database + uploaded photos          |
| `embedding-pgdata` | PostgreSQL data for photo embeddings       |

### Automatic daily backup (recommended)

The repo ships with a host-side hook that takes a daily
**application-consistent ZFS snapshot** including a `pg_dump` of the main DB.
Flow:

1. The host cron calls `POST /internal/backup/start` — fk-encore pauses the
   scan workers, puts the cluster into backup mode via `pg_backup_start()`,
   and writes a `pg_dump` to `/mnt/backup/encore-<label>.dump`.
2. The host runs `zfs snapshot -r tank/vivanty@<label>` — pgdata + photos
   + the dump that was just written are all consistently captured in the
   snapshot.
3. The host cron calls `POST /internal/backup/stop` — `pg_backup_stop()`,
   workers resume.

A safety timer (default 30 minutes) automatically ends backup mode if
`/stop` never arrives, so the WAL cannot grow without bound.

**Installation on the host (one time, as root):**

The fk-encore container ships the host-side hook scripts inside the image
and copies them onto the backup volume on every start. You do **not**
need to clone the fk-encore repo on the host. The path on the host is:

```
/mnt/<dataset>/<backup-dir>/host-scripts/
    ├── install-backup-hook.sh
    ├── fk-encore-backup.sh
    ├── format-backup-log.sh
    └── README.md
```

Run the installer from there:

```bash
sudo /mnt/<dataset>/<backup-dir>/host-scripts/install-backup-hook.sh
# or non-interactive:
sudo /mnt/<dataset>/<backup-dir>/host-scripts/install-backup-hook.sh \
    --dataset tank/vivanty
```

Why this layout? TrueNAS SCALE replaces the entire root filesystem on
every upgrade (new boot environment), so files under `/etc`,
`/usr/local/sbin` or `/etc/cron.d` would vanish. ZFS datasets survive
upgrades, so all persistent artefacts (the scripts and the token file
that the installer generates) live there.

The container only ever overwrites the three files it ships
(`install-backup-hook.sh`, `fk-encore-backup.sh`, `README.md`). The
`backup-token` file the installer writes is preserved across image
upgrades, and so is anything else you might have placed in that
directory.

The installer:

1. Asks for the dataset interactively (or takes `--dataset`).
2. Generates a random token at `<host-scripts>/backup-token`
   (`0600 root:root`). Re-runs preserve any existing non-empty token.
3. Prints both the `BACKUP_TOKEN=…` line for `.env` and the exact fields
   to fill in the TrueNAS UI cron-jobs form.

Add the printed token to `.env` next to `docker-compose.yml` and restart
the container:

```env
BACKUP_TOKEN=<value-printed-by-the-installer>
```

```bash
docker compose up -d --no-deps app
```

**Register the cron job via the TrueNAS UI** (do not write to
`/etc/cron.d/` — that does not survive a TrueNAS upgrade):

System Settings → Advanced → Cron Jobs → Add

| Field          | Value |
|----------------|-------|
| Description    | `fk-encore daily backup` |
| Command        | `ZFS_DATASET=<dataset> /mnt/<dataset>/<backup-dir>/host-scripts/fk-encore-backup.sh` |
| Run As User    | `root` |
| Schedule       | Custom → `0 3 * * *` (03:00 UTC) |
| Enabled        | yes |

The installer prints the exact command line to copy.

The `/internal/backup/*` endpoints are additionally guarded by a CIDR
allow-list (default: loopback + RFC1918 + IPv6 ULA). That rejects
requests from the public internet even if the token leaks. The defaults
already cover host-to-container traffic over the Docker bridge (SNAT-ed
to `172.17.0.1` or similar), so no adjustment is normally needed.
Override via `BACKUP_ALLOW_CIDRS` in `.env` if you have a non-standard
setup.

See `scripts/host/README.md` for full details and configuration.

### Restore

Two paths are supported:

**A) Full rollback (photos + DB, fast):**

```bash
docker compose down
sudo zfs rollback -r tank/vivanty@daily-20260413-030000
docker compose up -d
```

**B) Restore only the DB from a `pg_dump` (opt-in on startup):**

```bash
# 1. Place the dump file in the backup directory, renamed with the
#    "restore-" prefix
cp /mnt/backup/encore-daily-20260413-030000.dump \
   /mnt/backup/restore-20260414-rollback.dump

# 2. Restart the container
docker compose restart app
```

On boot, fk-encore detects the file, first writes a safety
`pre-restore-<ISO>.dump` of the current DB state, runs
`pg_restore --clean --if-exists`, and renames the trigger file to
`restored-…` so the restore is not re-applied on the next start.

**Emergency backup without ZFS snapshot (e.g. on non-TrueNAS systems):**

```bash
# Main DB only — back up photos separately via rsync/etc.
docker exec fk-encore-app sh -c \
    'pg_dump -Fc --no-owner "$POSTGRES_DATABASE" > /mnt/backup/encore-manual.dump'
```

## Common tasks

### Rebuild all services

```bash
docker compose build --no-cache
docker compose up -d
```

### Logs of a single service

```bash
docker compose logs -f app
docker compose logs -f embedding_service
docker compose logs -f insightface
```

### Restart a service

```bash
docker compose restart app
```

### Stop everything and clean up

```bash
docker compose down          # Stop services
docker compose down -v       # Stop services + delete volumes (CAUTION: data loss!)
```

## Troubleshooting

### "Embedding service unavailable"

The embedding service needs time on first start to load the ML models
(~1–2 minutes). Check the status:

```bash
docker compose logs embedding_service
curl http://localhost:8001/health  # if the port is exposed
```

### "FACE_MODELS_NOT_LOADED"

InsightFace loads the buffalo_l model on first start. That can take 1–2
minutes:

```bash
docker compose logs insightface
```

### Out of memory

The ML services together need about 4–6 GB of RAM. Increase the Docker
memory limit if necessary (Docker Desktop → Settings → Resources).

## Performance tuning

A server that is running large scan passes (embedding, face detection,
landmark, quality, thumbnail prewarm) competes with the HTTP API for
CPU, DB connections and the libuv thread pool. The defaults below keep
the photo UI responsive under sustained scan load.

### Environment variables

| Variable                         | Default | Description |
|----------------------------------|---------|-------------|
| `UV_THREADPOOL_SIZE`             | `16`    | Raised automatically at boot so sharp, crypto and `fs` calls never queue behind one another. Set explicitly if you want another value. |
| `IMAGE_POOL_SIZE`                | half CPU count, min 2, max 8 | Dedicated worker threads for sharp image resizing. `0` disables the pool and falls back to in-process sharp. |
| `POSTGRES_POOL_MAX`              | `20`    | pg pool size. Must be ≥ `WORKER_DB_RESERVED_SLOTS + 5`. |
| `WORKER_DB_RESERVED_SLOTS`       | `3`     | Connections kept free for HTTP handlers (scan workers wait when all non-reserved slots are used). |
| `SCAN_EMBEDDING_CONCURRENCY`     | `1`     | Parallel embedding jobs. Increase cautiously — each job holds a DB connection during the RPC. |
| `SCAN_FACE_CONCURRENCY`          | `1`     | Parallel face-detection jobs. |
| `SCAN_FACE_ASSIGN_CONCURRENCY`   | `1`     | Parallel face-assignment jobs (local-only, cheap). |
| `SCAN_LANDMARK_CONCURRENCY`      | `1`     | Parallel landmark jobs. |
| `SCAN_QUALITY_CONCURRENCY`       | `1`     | Parallel quality jobs. |
| `SCAN_THUMBNAIL_CONCURRENCY`     | `1`     | Parallel thumbnail-prewarm jobs. Sharp runs off the main thread via `IMAGE_POOL_SIZE`, so raising this scales mostly with disk IO. |
| `ENABLE_THUMBNAIL_PREWARM`       | `true`  | Generates 320/640/1280 thumbnails after every quality job. Set to `false` to save disk space at the cost of on-demand resizes. |
| `THUMBNAIL_PREWARM_WIDTHS`       | `320,640,1280` | Comma-separated list of widths the prewarm worker generates. |
| `EVENT_LOOP_SOFT_THRESHOLD_MS`   | `200`   | Lag above which expensive scan services are throttled. |
| `EVENT_LOOP_LAG_THRESHOLD_MS`    | `500`   | Lag above which all scan services pause dequeueing. |
| `WORKER_PRESSURE_DELAY_MS`       | `250`   | Delay between jobs under soft pressure. |
| `WORKER_HARD_PRESSURE_DELAY_MS`  | `1000`  | Delay between jobs under hard pressure. |
| `ML_RPC_TIMEOUT_MS`              | `600000` | Per-request timeout (ms) for worker-side ML RPCs (embedding/insightface/landmark). 10 min by default — raise on very slow hosts, lower when you have a GPU. |
| `ML_RPC_QUICK_TIMEOUT_MS`        | `60000`  | Per-request timeout (ms) for user-facing ML RPCs (`/search/text`, `/similar-groups`). |
| `ML_CONCURRENCY_EMBEDDING`       | `1`     | Max parallel requests to the embedding container. `embedding` and `quality` workers share this slot, so the default serializes them. Raise only with GPU. |
| `ML_CONCURRENCY_INSIGHTFACE`     | `1`     | Max parallel requests to the insightface container. |
| `ML_CONCURRENCY_LANDMARK`        | `1`     | Max parallel requests to the landmark container. |
| `HEALTH_CHECK_INTERVAL_MS`       | `60000` | Interval between ML `/health` pings. Lower = faster detection of container outages; the ping itself is cheap. |
| `HEALTH_CHECK_TIMEOUT_MS`        | `60000` | Timeout for a single health ping. Generous on purpose — a busy container may reply slowly without being unhealthy. |

> **Note on timeouts:** A worker-side timeout no longer marks the job
> as permanently failed. `MlRpcTimeoutError` is handled the same as
> `ServiceUnavailableError` — the job returns to `pending` and is
> retried by the next tick. This protects photos from losing their
> embedding/quality/landmark data when the ML container is briefly
> unresponsive.

### Reverse proxy for thumbnails

The Encore photo endpoint at `/photos/file/*` streams from the local
`THUMBNAIL_DIR` cache on cache-hit, but every request still enters the
Node.js event loop. For deployments with a front-end proxy (nginx,
Caddy, Traefik) it is cheaper to serve cached thumbnails directly from
disk and let Node handle only cache-misses.

Example nginx snippet (adjust paths to your `PHOTO_THUMBNAIL_DIR`):

```nginx
# Serve thumbnails directly from disk; fall through to Node on miss.
location ~* ^/photos/file/(?<rest>.+)$ {
    set $cache_base "";
    # Use Node for HEIC conversions and unsharded paths — only handle
    # sized thumbnails here because they match the prewarm output.
    if ($arg_w != "") {
        try_files /thumbnails/$cache_base $rest @node;
    }
    proxy_pass http://app:8080;
}

location @node {
    proxy_pass http://app:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

For most installations the simpler answer is to mount
`PHOTO_THUMBNAIL_DIR` as a shared volume and use nginx's built-in
proxy cache in front of Encore — the prewarm worker guarantees every
photo has its common widths ready, so the cache hit rate at the proxy
approaches 100 %.
