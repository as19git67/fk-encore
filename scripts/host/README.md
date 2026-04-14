# Host-side backup hook for fk-encore

The files in this directory are installed on the **host** (TrueNAS SCALE or any
Linux machine with ZFS) and coordinate an application-consistent backup:

```
┌──── host (root, cron) ────────────────────────────────────────────────┐
│                                                                       │
│   /usr/local/sbin/fk-encore-backup.sh                                 │
│       │                                                               │
│       ├─ POST /internal/backup/start  ── app pauses workers,          │
│       │                                    pg_backup_start(),         │
│       │                                    pg_dump encore             │
│       ├─ zfs snapshot -r tank/vivanty@<label>                         │
│       └─ POST /internal/backup/stop   ── app pg_backup_stop(),        │
│                                            resumes workers            │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Files

| File | Role |
|------|------|
| `fk-encore-backup.sh`      | The daily driver. Called by cron. |
| `install-backup-hook.sh`   | One-time installer. Generates token, deploys script + cron entry. |

## Install

Clone the fk-encore repo on the host (or copy `scripts/host/` via rsync) and
run the installer as root:

```bash
sudo ./scripts/host/install-backup-hook.sh --dataset tank/vivanty
```

That will:

1. Generate a random token and store it at `/etc/fk-encore/backup-token`
   (mode `0600`, owner `root:root`). If the file already exists it is kept
   as-is, so re-running is safe.
2. Copy `fk-encore-backup.sh` to `/usr/local/sbin/fk-encore-backup.sh`.
3. Create `/etc/cron.d/fk-encore-backup` with a daily 03:00 UTC entry. Use
   `--cron '<schedule>'` to override (5-field cron syntax).

The installer prints the generated token and a reminder to add it to the
project's `.env` so the container picks it up via the `BACKUP_TOKEN`
environment variable:

```bash
# .env (next to docker-compose.yml)
BACKUP_TOKEN=<value-printed-by-installer>
```

```bash
docker compose up -d --no-deps app   # pick up the new env var
```

Until `BACKUP_TOKEN` is set, `/internal/backup/*` responds with
`401 Unauthenticated`.

## Test the flow end-to-end

```bash
sudo /usr/local/sbin/fk-encore-backup.sh
zfs list -t snapshot | grep fk-encore || zfs list -t snapshot | tail
ls -la /mnt/backup/      # should contain encore-<label>.dump
```

Logs go to `/var/log/fk-encore-backup.log` via the cron entry. When the script
is run manually, logs go to stderr.

## Restore

Two restore paths are supported:

### Path A — full rollback (photos + DB)

On the host, stop the stack and roll the dataset back to the snapshot:

```bash
docker compose down
sudo zfs rollback -r tank/vivanty@daily-20260413-030000
docker compose up -d
```

The fk-encore app does not need to do anything. This is the fastest way to
recover from a bad deploy or a ransomware-style incident.

### Path B — restore only the DB from a pg_dump

Useful when the photos on disk are still intact (or were restored by another
mechanism) but the database needs to roll back.

1. Put the dump file into the backup volume on the host, renamed with the
   `restore-` prefix:

   ```bash
   cp /mnt/backup/encore-daily-20260413-030000.dump \
      /mnt/backup/restore-20260414-rollback.dump
   ```

2. Restart the container:

   ```bash
   docker compose restart app
   ```

3. On boot, `backup/startup.ts` detects the `restore-*.dump` file, writes a
   safety dump of the *current* DB as `pre-restore-<ISO-timestamp>.dump`, runs
   `pg_restore --clean --if-exists`, and renames the trigger file to
   `restored-20260414-rollback.dump` so the restore is not re-applied on the
   next start.

   Progress is logged to the app logs (look for `backup.startup.*`).

## Configuration (host side)

| Env var | Default | Effect |
|---------|---------|--------|
| `FK_ENCORE_URL`        | `http://localhost:8080`        | Where to reach the app. |
| `FK_BACKUP_TOKEN_FILE` | `/etc/fk-encore/backup-token`  | Path to the shared secret. |
| `ZFS_DATASET`          | `tank/vivanty`                 | Dataset for `zfs snapshot -r`. |
| `LABEL`                | `daily-<UTC timestamp>`        | Snapshot and dump label. |
| `CURL_TIMEOUT`         | `30`                           | Per-HTTP-call timeout (seconds). |

Override by editing `/etc/cron.d/fk-encore-backup` and adding env-var lines
above the schedule line.

## Configuration (app side)

The app reads these from the container environment (see `docker-compose.yml`):

| Env var | Default | Effect |
|---------|---------|--------|
| `BACKUP_DIR`          | `/mnt/backup`           | Where dumps and the `restore-*.dump` trigger live. |
| `BACKUP_AUTO_STOP_MS` | `1800000` (30 min)      | Safety timer — force-stops a stuck backup if `/stop` never arrives. |

`BACKUP_TOKEN` must be provisioned in the app container's environment (via
the project's `.env` / `docker-compose.yml`). It is the shared value
between this directory's installer and the app, and must match the contents
of `/etc/fk-encore/backup-token`.

## Security

- The token file is `0600 root:root`. The cron job runs as root, reads the
  token, and calls the app over loopback HTTP.
- The `/internal/backup/*` endpoints perform a constant-time comparison
  against the `BackupToken` secret. If the secret is not configured, every
  call fails closed with `401 Unauthenticated`.
- `pg_backup_start()` does not block reads; browser sessions continue to see
  a `503 Service Unavailable` via the maintenance middleware. `/health` and
  `/healthz` stay up so external monitoring is not poisoned.
