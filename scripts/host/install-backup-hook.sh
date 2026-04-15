#!/usr/bin/env bash
#
# One-time installer for the fk-encore backup hook on a TrueNAS SCALE host.
#
# TrueNAS SCALE wipes the root filesystem on every upgrade (new boot
# environment), so anything under /etc, /usr/local/sbin or /etc/cron.d
# would vanish after the next upgrade. This installer instead places all
# persistent artefacts on a ZFS dataset under /mnt/<dataset>/fk-encore-hook/
# — datasets survive upgrades. The cron entry itself is NOT written into
# /etc/cron.d/; instead the script prints copy-paste instructions for the
# TrueNAS UI (System Settings → Advanced → Cron Jobs), which stores cron
# definitions in the config DB and therefore also survives upgrades.
#
# What it does:
#   1. Asks for the ZFS dataset (e.g. tank/vivanty) unless --dataset is given.
#      Verifies /mnt/<dataset> is present and is not the boot pool.
#   2. Creates /mnt/<dataset>/fk-encore-hook/ (mode 0700, owner root:root).
#   3. Generates a 32-byte random token and writes it to
#      <install-dir>/backup-token (mode 0600, owner root:root). Re-run safe:
#      an existing non-empty token file is kept.
#   4. Copies fk-encore-backup.sh to <install-dir>/fk-encore-backup.sh.
#   5. Prints the BACKUP_TOKEN value for the project's .env and the exact
#      TrueNAS UI fields to fill in for the daily cron job.
#
# Usage (as root):
#   ./install-backup-hook.sh [--dataset tank/vivanty]
#
# Re-run-safe: every step is idempotent.

set -euo pipefail

DATASET=""
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/fk-encore-backup.sh"

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

if [[ ! -r "$SCRIPT_SRC" ]]; then
  echo "cannot read $SCRIPT_SRC — run this script from the repository's scripts/host/ directory" >&2
  exit 1
fi

# --- dataset prompt --------------------------------------------------------
if [[ -z "$DATASET" ]]; then
  # Try to offer a sensible default by listing top-level datasets on
  # non-boot pools. If exactly one candidate exists, use it as the default.
  DEFAULT_DATASET=""
  if command -v zfs >/dev/null 2>&1; then
    mapfile -t CANDIDATES < <(zfs list -H -o name -d 1 2>/dev/null \
      | grep -vE '^(boot-pool(/.*)?$|.+/\.ix-apps$|.+/ix-applications$)' \
      | grep '/' || true)
    if [[ "${#CANDIDATES[@]}" -eq 1 ]]; then
      DEFAULT_DATASET="${CANDIDATES[0]}"
    fi
  fi

  echo "On which ZFS dataset should the backup hook be installed?"
  echo "  (this is the dataset that will also be targeted by 'zfs snapshot -r';"
  echo "   typically the one containing pgdata, photos and the backup dump dir)"
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

# Refuse the boot pool — defeats the whole purpose.
POOL="${DATASET%%/*}"
if [[ "$POOL" == "boot-pool" ]]; then
  echo "FATAL: refusing to install on the boot-pool — it is wiped on every TrueNAS upgrade" >&2
  exit 1
fi

MOUNTPOINT="/mnt/$DATASET"
if [[ ! -d "$MOUNTPOINT" ]]; then
  echo "FATAL: $MOUNTPOINT does not exist — is the dataset mounted?" >&2
  exit 1
fi

INSTALL_DIR="$MOUNTPOINT/fk-encore-hook"
TOKEN_FILE="$INSTALL_DIR/backup-token"
SCRIPT_DST="$INSTALL_DIR/fk-encore-backup.sh"

# --- install-dir -----------------------------------------------------------
mkdir -p "$INSTALL_DIR"
chmod 0700 "$INSTALL_DIR"
chown root:root "$INSTALL_DIR"

# --- token -----------------------------------------------------------------
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
     This lives in the TrueNAS config DB and therefore survives upgrades —
     a file under /etc/cron.d/ would not.

     Fill the form with:

       Description:   fk-encore daily backup
       Command:       ZFS_DATASET=$DATASET $SCRIPT_DST
       Run As User:   root
       Schedule:      Custom → 0 3 * * *   (03:00 UTC daily)
       Hide Stdout:   no    (so any warning triggers a cron mail)
       Hide Stderr:   no
       Enabled:       yes

  3. Verify end-to-end (run as root on the host):

       ZFS_DATASET=$DATASET $SCRIPT_DST
       zfs list -t snapshot | grep "$DATASET@" | tail

     The pg_dump file will appear in the app's BACKUP_DIR, which is bind-
     mounted into the container and is typically a sibling directory to the
     install dir (see docker-compose.yml).
-----------------------------------------------------------------------------
EOF
