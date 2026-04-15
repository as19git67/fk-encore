#!/usr/bin/env bash
#
# One-time setup helper for the fk-encore backup hook.
#
# Workflow on TrueNAS SCALE:
#
#   1. Bring the fk-encore stack up at least once. The container then copies
#      this script and `fk-encore-backup.sh` onto the backup volume at
#      /mnt/<dataset>/<backup-dir>/host-scripts/ (see backup/startup.ts).
#   2. SSH to the host as root and run THIS script from that directory:
#        sudo /mnt/<dataset>/<backup-dir>/host-scripts/install-backup-hook.sh
#   3. Follow the on-screen instructions to register the daily cron job
#      via the TrueNAS UI (System Settings → Advanced → Cron Jobs).
#
# This script is fully stateless except for the token file it writes next to
# itself (`backup-token`). All runtime input is taken from $1/--dataset or
# from an interactive prompt, so re-running the script (or having the
# container overwrite it on the next start) is harmless: the token is
# preserved (it lives outside the set of files the container manages),
# and the rest is just printed reminders.
#
# Usage (as root):
#   ./install-backup-hook.sh                       # interactive prompt
#   ./install-backup-hook.sh --dataset tank/foo    # non-interactive
#
# Idempotent: re-running keeps the existing token unchanged.

set -euo pipefail

DATASET=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVER_SCRIPT="$SCRIPT_DIR/fk-encore-backup.sh"
TOKEN_FILE="$SCRIPT_DIR/backup-token"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dataset) DATASET="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "must run as root" >&2
  exit 1
fi

if [[ ! -x "$DRIVER_SCRIPT" ]]; then
  echo "FATAL: $DRIVER_SCRIPT not found or not executable." >&2
  echo "       This script is meant to run from the host-scripts/ directory" >&2
  echo "       seeded by the fk-encore container onto the backup volume." >&2
  echo "       Has the container been started at least once?" >&2
  exit 1
fi

# --- dataset prompt --------------------------------------------------------
# We only need the dataset to template the cron-job command line and to
# prove the install location is on a real ZFS dataset (i.e. survives a
# TrueNAS upgrade).
if [[ -z "$DATASET" ]]; then
  DEFAULT_DATASET=""
  if command -v zfs >/dev/null 2>&1; then
    mapfile -t CANDIDATES < <(zfs list -H -o name -d 1 2>/dev/null \
      | grep -vE '^(boot-pool(/.*)?$|.+/\.ix-apps$|.+/ix-applications$)' \
      | grep '/' || true)
    if [[ "${#CANDIDATES[@]}" -eq 1 ]]; then
      DEFAULT_DATASET="${CANDIDATES[0]}"
    fi
  fi

  echo "Which ZFS dataset should be snapshotted by the daily backup?"
  echo "  (typically the dataset that holds pgdata, photos and the backup dump dir;"
  echo "   it will be the target of 'zfs snapshot -r')"
  if [[ -n "$DEFAULT_DATASET" ]]; then
    read -r -p "Dataset [$DEFAULT_DATASET]: " DATASET
    DATASET="${DATASET:-$DEFAULT_DATASET}"
  else
    read -r -p "Dataset (e.g. tank/vivanty): " DATASET
  fi
fi

if [[ -z "$DATASET" ]]; then
  echo "FATAL: no dataset given" >&2
  exit 1
fi

# Reject obviously-bogus input (absolute paths, spaces).
if [[ "$DATASET" =~ ^/ ]] || [[ "$DATASET" =~ [[:space:]] ]]; then
  echo "FATAL: dataset must be of the form pool/name (no leading slash, no spaces): '$DATASET'" >&2
  exit 1
fi

POOL="${DATASET%%/*}"
if [[ "$POOL" == "boot-pool" ]]; then
  echo "FATAL: refusing to use boot-pool — it is wiped on every TrueNAS upgrade" >&2
  exit 1
fi

if [[ ! -d "/mnt/$DATASET" ]]; then
  echo "FATAL: /mnt/$DATASET does not exist — is the dataset mounted?" >&2
  exit 1
fi

# --- token -----------------------------------------------------------------
# The token file lives next to this script. The container's seedHostScripts()
# only overwrites the .sh / .md files it ships, never the token, so it
# survives image upgrades.
if [[ -s "$TOKEN_FILE" ]]; then
  echo "[ok] token file already exists at $TOKEN_FILE — leaving it unchanged"
else
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')"
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
  chmod 0600 "$TOKEN_FILE"
  chown root:root "$TOKEN_FILE"
  echo "[ok] wrote new token to $TOKEN_FILE"
fi

# Be defensive about the driver script's mode in case the container ran as
# a different uid and chmod didn't stick.
chmod 0755 "$DRIVER_SCRIPT"

# --- reminder --------------------------------------------------------------
TOKEN_VALUE="$(tr -d '[:space:]' < "$TOKEN_FILE")"
cat <<EOF

-----------------------------------------------------------------------------
Next steps — finish the install by:

  1. Add this line to the .env next to docker-compose.yml:

       BACKUP_TOKEN=$TOKEN_VALUE

     Then restart the app so it picks up the new env var:

       docker compose up -d --no-deps app

  2. Register the daily cron job via the TrueNAS SCALE UI
     (System Settings → Advanced → Cron Jobs → Add).
     This entry lives in the TrueNAS config DB and survives upgrades — a
     file under /etc/cron.d/ would not.

     Fill the form with:

       Description:   fk-encore daily backup
       Command:       ZFS_DATASET=$DATASET $DRIVER_SCRIPT
       Run As User:   root
       Schedule:      Custom → 0 3 * * *   (03:00 UTC daily)
       Hide Stdout:   no    (so any warning triggers a cron mail)
       Hide Stderr:   no
       Enabled:       yes

  3. Verify end-to-end (run as root on the host):

       ZFS_DATASET=$DATASET $DRIVER_SCRIPT
       zfs list -t snapshot | grep "$DATASET@" | tail

     The pg_dump file appears in the backup volume, sibling to the
     host-scripts/ directory you are in right now.
-----------------------------------------------------------------------------
EOF
