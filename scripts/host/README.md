# Host-side backup hook for fk-encore

The files in this directory are installed on the **host** (TrueNAS SCALE or
any Linux machine with ZFS) and coordinate an application-consistent
backup:

```
┌──── host (root, cron) ─────────────────────────────────────────────────┐
│                                                                        │
│   /mnt/<dataset>/fk-encore-hook/fk-encore-backup.sh                    │
│       │                                                                │
│       ├─ POST /internal/backup/start  ── app pauses workers,           │
│       │                                    pg_backup_start(),          │
│       │                                    pg_dump encore              │
│       ├─ zfs snapshot -r <dataset>@<label>                             │
│       └─ POST /internal/backup/stop   ── app pg_backup_stop(),         │
│                                            resumes workers             │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Upgrade safety on TrueNAS SCALE

TrueNAS SCALE replaces the root filesystem on every upgrade (new boot
environment). Anything under `/etc`, `/usr/local/sbin` or `/etc/cron.d`
would vanish at the next upgrade. This installer therefore places **all**
persistent artefacts on a ZFS dataset under
`/mnt/<dataset>/fk-encore-hook/`, and the cron job itself is registered
via the TrueNAS UI (System Settings → Advanced → Cron Jobs), which is
stored in the config DB — both survive upgrades.

## Files

| File                     | Role |
|--------------------------|------|
| `fk-encore-backup.sh`    | The daily driver. Installed onto the dataset, called by the TrueNAS cron job. |
| `install-backup-hook.sh` | One-time installer. Prompts for the dataset, generates the token, deploys the driver. |

## Install

Clone the fk-encore repo on the host (or copy `scripts/host/` via rsync)
and run the installer as root. The installer prompts for the ZFS dataset
interactively; pass `--dataset` to skip the prompt:

```bash
sudo ./scripts/host/install-backup-hook.sh
# or non-interactive:
sudo ./scripts/host/install-backup-hook.sh --dataset tank/vivanty
```

The installer will:

1. Create `/mnt/<dataset>/fk-encore-hook/` (mode `0700`, owner `root:root`).
2. Generate a 32-byte random token and write it to
   `/mnt/<dataset>/fk-encore-hook/backup-token` (mode `0600`,
   owner `root:root`). If a non-empty file exists it is kept as-is, so
   re-running the installer is safe and idempotent.
3. Copy `fk-encore-backup.sh` to
   `/mnt/<dataset>/fk-encore-hook/fk-encore-backup.sh` (mode `0755`,
   owner `root:root`). The driver reads the token from its sibling
   `backup-token` by default — no env-var plumbing needed.
4. Print the `BACKUP_TOKEN=…` line for the app's `.env` plus the exact
   fields to fill in the TrueNAS cron-jobs form.

The installer refuses to install on `boot-pool/*` — that dataset is wiped
on upgrade.

Until `BACKUP_TOKEN` is set in the app's environment, `/internal/backup/*`
responds with `401 Unauthenticated`.

### Cron-job via the TrueNAS UI

Do **not** write into `/etc/cron.d/` on TrueNAS SCALE — it is not
preserved across upgrades. Use the UI instead:

1. System Settings → Advanced → Cron Jobs → **Add**.
2. Fill the form:

   | Field          | Value |
   |----------------|-------|
   | Description    | `fk-encore daily backup` |
   | Command        | `ZFS_DATASET=<your-dataset> /mnt/<dataset>/fk-encore-hook/fk-encore-backup.sh` |
   | Run As User    | `root` |
   | Schedule       | Custom → `0 3 * * *` (03:00 UTC daily) |
   | Hide Stdout    | no (so any warning triggers a cron mail) |
   | Hide Stderr    | no |
   | Enabled        | yes |

The installer's final output contains the exact command line for copy/paste.

## Test the flow end-to-end

Run the driver manually as root:

```bash
sudo ZFS_DATASET=tank/vivanty /mnt/tank/vivanty/fk-encore-hook/fk-encore-backup.sh
zfs list -t snapshot | grep "tank/vivanty@" | tail
ls -la /mnt/tank/vivanty/backup/   # should contain encore-<label>.dump
```

When the script is run manually, logs go to stderr. When invoked by the
TrueNAS cron job, stdout/stderr flow into the cron mail (unless you hid
them in the form).

## Restore

Two restore paths are supported:

### Path A — full rollback (photos + DB)

On the host, stop the stack and roll the dataset back to the snapshot:

```bash
docker compose down
sudo zfs rollback -r tank/vivanty@daily-20260413-030000
docker compose up -d
```

The fk-encore app does not need to do anything. This is the fastest way
to recover from a bad deploy or a ransomware-style incident.

Note: a full rollback also reverts
`/mnt/<dataset>/fk-encore-hook/backup-token` to the token that was
current at the time of the snapshot. If you had rotated the token
afterwards, put the newer token back into the `.env` (or simply re-run
the installer, which keeps the token file untouched if it already exists).

### Path B — restore only the DB from a pg_dump

Useful when the photos on disk are still intact (or were restored by
another mechanism) but the database needs to roll back.

1. Put the dump file into the backup volume on the host, renamed with
   the `restore-` prefix:

   ```bash
   cp /mnt/tank/vivanty/backup/encore-daily-20260413-030000.dump \
      /mnt/tank/vivanty/backup/restore-20260414-rollback.dump
   ```

2. Restart the container:

   ```bash
   docker compose restart app
   ```

3. On boot, `backup/startup.ts` detects the `restore-*.dump` file, writes
   a safety dump of the *current* DB as
   `pre-restore-<ISO-timestamp>.dump`, runs
   `pg_restore --clean --if-exists`, and renames the trigger file to
   `restored-20260414-rollback.dump` so the restore is not re-applied on
   the next start.

   Progress is logged to the app logs (look for `backup.startup.*`).

## Configuration (host side)

| Env var | Default | Effect |
|---------|---------|--------|
| `FK_ENCORE_URL`        | `http://localhost:8080`             | Where to reach the app. |
| `FK_BACKUP_TOKEN_FILE` | `<script-dir>/backup-token`         | Path to the shared secret. Defaults to a sibling of the script on the dataset. |
| `ZFS_DATASET`          | `tank/vivanty`                      | Dataset for `zfs snapshot -r`. Override via the cron-job command line. |
| `LABEL`                | `daily-<UTC timestamp>`             | Snapshot and dump label. |
| `CURL_TIMEOUT`         | `30`                                | Per-HTTP-call timeout (seconds). |

Override by editing the TrueNAS cron-job **Command** field, e.g.:

```
ZFS_DATASET=tank/vivanty FK_ENCORE_URL=http://localhost:8080 /mnt/tank/vivanty/fk-encore-hook/fk-encore-backup.sh
```

## Configuration (app side)

The app reads these from the container environment (see `docker-compose.yml`):

| Env var | Default | Effect |
|---------|---------|--------|
| `BACKUP_DIR`          | `/mnt/backup`           | Where dumps and the `restore-*.dump` trigger live (inside the container). |
| `BACKUP_AUTO_STOP_MS` | `1800000` (30 min)      | Safety timer — force-stops a stuck backup if `/stop` never arrives. |
| `BACKUP_ALLOW_CIDRS`  | *(see below)*           | Comma-separated CIDR allow-list for the peer address. |
| `BACKUP_TRUST_XFF`    | `false`                 | If `true`, use the left-most `X-Forwarded-For` entry as the peer address. |

`BACKUP_TOKEN` must be provisioned in the app container's environment
(via the project's `.env` / `docker-compose.yml`). It is the shared value
between this directory's installer and the app, and must match the
contents of `/mnt/<dataset>/fk-encore-hook/backup-token`.

## Security

- The token file is `0600 root:root` on a dataset that is not exposed to
  containers. The cron job runs as root, reads the token, and calls the
  app over loopback HTTP.
- The `/internal/backup/*` endpoints are guarded by **two** checks that
  run in order:
  1. **CIDR allow-list.** The peer address must fall inside
     `BACKUP_ALLOW_CIDRS`. Defaults: `127.0.0.0/8`, `::1/128`,
     `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`
     (loopback + RFC1918 + IPv6 ULA). That covers host-to-container
     traffic through the Docker bridge (SNAT-ed to `172.17.0.1` or
     similar) and container-to-container traffic, while rejecting
     requests from the public internet even if port 8080 is exposed.
     Override with `BACKUP_ALLOW_CIDRS=<cidr>,<cidr>,...` in the
     container environment. Malformed entries are logged and skipped;
     an empty or unparseable peer address fails closed.
  2. **Bearer token.** Constant-time compare against `BACKUP_TOKEN`. If
     the token is not configured, every call fails closed with
     `401 Unauthenticated`.
- Only set `BACKUP_TRUST_XFF=true` when the app is behind a reverse
  proxy that you control. Trusting `X-Forwarded-For` unconditionally
  would let a remote client spoof the peer address and bypass the
  allow-list.
- `pg_backup_start()` does not block reads; browser sessions continue to
  see a `503 Service Unavailable` via the maintenance middleware.
  `/health` and `/healthz` stay up so external monitoring is not
  poisoned.
