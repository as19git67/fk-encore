# Host-side backup hook for fk-encore

The files in this directory coordinate an application-consistent backup
between a host-side cron job and the fk-encore container:

```
┌──── host (root, TrueNAS UI cron) ──────────────────────────────────────┐
│                                                                        │
│   /mnt/<dataset>/<backup-dir>/host-scripts/fk-encore-backup.sh         │
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

## How the scripts get onto the host

You do **not** need to clone the fk-encore repo on the host. Every time
the fk-encore container starts, it copies the three files in this
directory onto the backup volume at:

```
/mnt/<dataset>/<backup-dir>/host-scripts/
    ├── install-backup-hook.sh
    ├── fk-encore-backup.sh
    ├── format-backup-log.sh
    └── README.md
```

(The container only ever overwrites those four files. Anything else in
that directory — most importantly the `backup-token` written by the
installer — is preserved across image upgrades.)

The path is a sibling of the pg_dump output dir. Both live on a ZFS
dataset, which means they survive a TrueNAS SCALE upgrade. Files placed
under `/etc`, `/usr/local/sbin` or `/etc/cron.d` would not — TrueNAS
replaces the boot environment on every upgrade. The cron job itself is
registered via the TrueNAS UI so it lives in the config DB and is
upgrade-safe too.

## Files

| File                     | Role |
|--------------------------|------|
| `fk-encore-backup.sh`    | The daily driver. Stateless; reads everything from env vars / the sibling token file. The cron job calls this. |
| `install-backup-hook.sh` | One-time setup helper. Generates the token file (if absent) and prints the cron-job fields to fill in the TrueNAS UI. |
| `format-backup-log.sh`   | Optional log formatter. Reads `fk-encore-backup.sh` output (stdin or file) and emits a human-readable protocol followed by the raw log. Intended for cron mail. |

## Install

1. Bring the fk-encore stack up at least once so the container seeds the
   scripts onto the backup volume:

   ```bash
   docker compose up -d
   ```

2. SSH to the host as root and run the installer from where the container
   put it:

   ```bash
   sudo /mnt/<dataset>/<backup-dir>/host-scripts/install-backup-hook.sh
   # or non-interactive:
   sudo /mnt/<dataset>/<backup-dir>/host-scripts/install-backup-hook.sh --dataset tank/vivanty
   ```

   The installer will:

   - Prompt for the ZFS dataset (used both for the cron-job command-line
     template and for the `zfs snapshot -r` target). A sensible default is
     suggested if `zfs list` reports a single non-boot dataset.
   - Generate a 32-byte random token at
     `<host-scripts>/backup-token` (mode `0600`, owner `root:root`).
     Re-runs are idempotent — an existing non-empty token is preserved.
   - Print the `BACKUP_TOKEN=…` line for the project's `.env` and the
     exact fields to fill in the TrueNAS UI cron-jobs form.

3. Add the printed `BACKUP_TOKEN=…` line to `.env` next to
   `docker-compose.yml` and restart the app:

   ```bash
   docker compose up -d --no-deps app
   ```

   Until `BACKUP_TOKEN` is set, `/internal/backup/*` responds with
   `401 Unauthenticated`.

4. Register the daily cron job via the TrueNAS UI (System Settings →
   Advanced → Cron Jobs → Add). The installer's last lines contain the
   exact command line to paste into the **Command** field, including the
   `ZFS_DATASET=…` prefix.

## Why is the daily script overwritten on every container start?

Because that's exactly what makes upgrades painless: the script that runs
on the host always matches the version that was shipped with the
currently-running container image. Both `install-backup-hook.sh` and
`fk-encore-backup.sh` are entirely stateless — every input comes from an
env var, a CLI argument, or an interactive prompt. They never store
anything in their own source directory other than the token file
(written by the installer). The container's seed step explicitly leaves
the token file alone, so credentials are stable across upgrades.

If you ever need to pin a specific version on the host, copy the scripts
out of `host-scripts/` and adjust the cron-job command to point at the
copy.

## Test the flow end-to-end

Run the driver manually as root:

```bash
sudo ZFS_DATASET=tank/vivanty \
     /mnt/tank/vivanty/backup/host-scripts/fk-encore-backup.sh
zfs list -t snapshot | grep "tank/vivanty@" | tail
ls -la /mnt/tank/vivanty/backup/   # should contain encore-<label>.dump
```

When run manually, logs go to stderr. When invoked by the TrueNAS cron
job, stdout/stderr flow into the cron mail (unless you hid them in the
form).

### Readable cron-mail summary

Pipe the raw log through `format-backup-log.sh` to get a compact protocol
(label, duration, per-step timeline, prune list, warnings/errors) ahead of
the raw log. In the TrueNAS UI cron-job **Command** field:

```bash
bash -c 'set -o pipefail; ZFS_DATASET=tank/vivanty \
    /mnt/tank/vivanty/backup/host-scripts/fk-encore-backup.sh 2>&1 \
    | /mnt/tank/vivanty/backup/host-scripts/format-backup-log.sh'
```

`set -o pipefail` ensures the overall exit code is non-zero when
`fk-encore-backup.sh` fails, so TrueNAS still flags the job as failed even
though the formatter itself always exits successfully. The formatter can
also be pointed at a saved log: `format-backup-log.sh /path/to/backup.log`.

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

Note: a full rollback also reverts the `backup-token` file to whatever
was current at the time of the snapshot. If you had rotated the token
afterwards, copy the newer token back into `.env` (or just re-run the
installer, which preserves the existing token file).

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

`fk-encore-backup.sh` accepts overrides via env vars:

| Env var                   | Default                        | Effect |
|---------------------------|--------------------------------|--------|
| `FK_ENCORE_URL`           | `http://localhost:8080`        | Where to reach the app. |
| `FK_BACKUP_TOKEN_FILE`    | `<script-dir>/backup-token`    | Path to the shared secret. The default is the file the installer writes next to the script. |
| `ZFS_DATASET`             | `tank/vivanty`                 | Dataset for `zfs snapshot -r`. Override via the cron-job command line. |
| `LABEL`                   | `daily-<UTC timestamp>`        | Snapshot and dump label. |
| `CURL_TIMEOUT`            | `30`                           | Per-HTTP-call timeout in seconds. |
| `SNAPSHOT_RETENTION_DAYS` | `30`                           | After a successful backup, destroy `daily-*` snapshots of `$ZFS_DATASET` whose `creation` timestamp is older than N days. Set `0` to disable. Only labels starting with `daily-` are touched — manual snapshots are preserved. The current run's snapshot is always kept. Prune errors are logged as `WARN` and do not fail the backup. |

Override by editing the cron-job **Command** field in the TrueNAS UI:

```
ZFS_DATASET=tank/vivanty FK_ENCORE_URL=http://localhost:8080 \
    /mnt/tank/vivanty/backup/host-scripts/fk-encore-backup.sh
```

## Configuration (app side)

The app reads these from the container environment (see
`docker-compose.yml`):

| Env var               | Default            | Effect |
|-----------------------|--------------------|--------|
| `BACKUP_DIR`          | `/mnt/backup`      | Where dumps and the `restore-*.dump` trigger live (inside the container). The seed step writes `host-scripts/` here too. |
| `BACKUP_AUTO_STOP_MS` | `1800000` (30 min) | Safety timer — force-stops a stuck backup if `/stop` never arrives. |
| `BACKUP_ALLOW_CIDRS`  | *(see below)*      | Comma-separated CIDR allow-list for the peer address. |
| `BACKUP_TRUST_XFF`    | `true`             | Read the peer IP from the left-most `X-Forwarded-For` entry. Required under Encore.ts (the real TCP peer is relayed via XFF, not the Node socket). Set to `false` only in test rigs that bypass Encore. |

`BACKUP_TOKEN` must be provisioned in the app container's environment
(via the project's `.env` / `docker-compose.yml`). It is the shared
value between the installer and the app, and must match the contents of
`<host-scripts>/backup-token`.

## Security

- The token file is `0600 root:root` on a ZFS dataset that is only
  reachable via the host filesystem. The cron job runs as root, reads
  the token, and calls the app over loopback HTTP.
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
- `BACKUP_TRUST_XFF` defaults to `true` because Encore.ts' Rust HTTP
  layer proxies requests into Node and sets `X-Forwarded-For` from the
  verified TCP peer — the socket address inside the handler is the
  internal proxy, not the real client. If you deploy the app standalone
  (i.e. without Encore in front), set `BACKUP_TRUST_XFF=false` so a
  remote client cannot spoof the peer IP by supplying its own XFF.
- `pg_backup_start()` does not block reads; browser sessions continue to
  see a `503 Service Unavailable` via the maintenance middleware.
  `/health` and `/healthz` stay up so external monitoring is not
  poisoned.
