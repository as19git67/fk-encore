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
