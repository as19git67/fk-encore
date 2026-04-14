#!/usr/bin/env bash
#
# One-time installer for the fk-encore backup hook on a TrueNAS SCALE host.
#
#   - Generates a 32-byte random token (if one does not already exist).
#   - Stores it at /etc/fk-encore/backup-token (mode 0600, owner root:root).
#   - Prints the encore-CLI command you need to run inside the container so
#     the app can read the same value via the BackupToken secret.
#   - Installs /usr/local/sbin/fk-encore-backup.sh and a cron entry at
#     /etc/cron.d/fk-encore-backup (daily at 03:00 UTC by default).
#
# Re-run-safe: if the token and cron entry already exist, the script only
# updates the backup driver script.
#
# Usage (as root):
#   ./install-backup-hook.sh [--cron '0 3 * * *'] [--dataset tank/vivanty]
#
# After running, finish the install with:
#   docker exec -i fk-encore-app encore secret set --type production BackupToken
#   (paste the token when prompted)

set -euo pipefail

CRON_SCHEDULE="0 3 * * *"
DATASET=""
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/fk-encore-backup.sh"
SCRIPT_DST="/usr/local/sbin/fk-encore-backup.sh"
TOKEN_DIR="/etc/fk-encore"
TOKEN_FILE="$TOKEN_DIR/backup-token"
CRON_FILE="/etc/cron.d/fk-encore-backup"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cron)    CRON_SCHEDULE="$2"; shift 2 ;;
    --dataset) DATASET="$2";       shift 2 ;;
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

if [[ ! -r "$SCRIPT_SRC" ]]; then
  echo "cannot read $SCRIPT_SRC — run this script from the repository's scripts/host/ directory" >&2
  exit 1
fi

# --- token -----------------------------------------------------------------
mkdir -p "$TOKEN_DIR"
chmod 0700 "$TOKEN_DIR"
chown root:root "$TOKEN_DIR"

if [[ -s "$TOKEN_FILE" ]]; then
  echo "[ok] token file already exists at $TOKEN_FILE — leaving it unchanged"
else
  # 32 bytes of randomness, base64 URL-safe, no padding.
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')"
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
  chmod 0600 "$TOKEN_FILE"
  chown root:root "$TOKEN_FILE"
  echo "[ok] wrote new token to $TOKEN_FILE"
fi

# --- driver script ---------------------------------------------------------
install -m 0755 -o root -g root "$SCRIPT_SRC" "$SCRIPT_DST"
echo "[ok] installed $SCRIPT_DST"

# --- cron entry ------------------------------------------------------------
ENV_LINES=""
if [[ -n "$DATASET" ]]; then
  ENV_LINES="ZFS_DATASET=$DATASET"$'\n'
fi
cat > "$CRON_FILE" <<EOF
# fk-encore daily backup — installed by scripts/host/install-backup-hook.sh
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${ENV_LINES}$CRON_SCHEDULE root $SCRIPT_DST >> /var/log/fk-encore-backup.log 2>&1
EOF
chmod 0644 "$CRON_FILE"
chown root:root "$CRON_FILE"
echo "[ok] installed $CRON_FILE (schedule: $CRON_SCHEDULE)"

# --- reminder --------------------------------------------------------------
cat <<EOF

-----------------------------------------------------------------------------
Finish the install by giving the same token to the fk-encore app:

  docker exec -i fk-encore-app encore secret set --type production BackupToken

Paste the value of $TOKEN_FILE when prompted, then restart the container:

  docker compose restart app

Verify end-to-end:

  $SCRIPT_DST
  zfs list -t snapshot | grep fk-encore || zfs list -t snapshot | tail
-----------------------------------------------------------------------------
EOF
