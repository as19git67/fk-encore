#!/usr/bin/env bash
#
# fk-encore daily backup driver.
#
# Runs on the TrueNAS SCALE host as root (via cron or a TrueNAS periodic
# task). Coordinates with the fk-encore app over HTTP so that the ZFS
# snapshot taken in step 2 is application-consistent:
#
#   1. POST /internal/backup/start
#        -> app pauses scan workers, calls pg_backup_start(), and writes a
#           pg_dump to $BACKUP_DIR/encore-$LABEL.dump
#   2. zfs snapshot -r $ZFS_DATASET@$LABEL
#        -> host-side snapshot, captures pgdata + photos consistently
#        -> the pg_dump from step 1 is inside the snapshot too
#   3. POST /internal/backup/stop
#        -> app calls pg_backup_stop(), resumes scan workers, leaves
#           maintenance mode
#
# Exit codes:
#   0  success
#   1  pre-flight failure (missing token / API unreachable)
#   2  /start failed
#   3  zfs snapshot failed (attempts /stop before exiting)
#   4  /stop failed
#
# Configuration (env vars override defaults):
#   FK_ENCORE_URL        base URL of the app, default http://localhost:8080
#   FK_BACKUP_TOKEN_FILE path to token file,  default: ./backup-token next to
#                        this script (that is where install-backup-hook.sh
#                        places it — on a ZFS dataset, upgrade-safe)
#   ZFS_DATASET          dataset for snapshot, default tank/vivanty
#   LABEL                snapshot + dump label, default daily-<UTC timestamp>
#   CURL_TIMEOUT         seconds, default 30
#
# Designed for bash 4+. Use `set -euo pipefail` so the trap-based /stop
# always runs on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FK_ENCORE_URL="${FK_ENCORE_URL:-http://localhost:8080}"
FK_BACKUP_TOKEN_FILE="${FK_BACKUP_TOKEN_FILE:-$SCRIPT_DIR/backup-token}"
ZFS_DATASET="${ZFS_DATASET:-tank/vivanty}"
LABEL="${LABEL:-daily-$(date -u +%Y%m%d-%H%M%S)}"
CURL_TIMEOUT="${CURL_TIMEOUT:-30}"

log() { printf '[fk-encore-backup %s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# -- pre-flight -----------------------------------------------------------
if [[ ! -r "$FK_BACKUP_TOKEN_FILE" ]]; then
  log "FATAL: token file $FK_BACKUP_TOKEN_FILE is not readable — did install-backup-hook.sh run?"
  exit 1
fi
TOKEN="$(tr -d '[:space:]' < "$FK_BACKUP_TOKEN_FILE")"
if [[ -z "$TOKEN" ]]; then
  log "FATAL: token file is empty"
  exit 1
fi

if ! command -v zfs >/dev/null 2>&1; then
  log "FATAL: zfs binary not found on PATH — this script must run on the TrueNAS host"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  log "FATAL: curl binary not found on PATH"
  exit 1
fi

call_api() {
  local method="$1" path="$2"
  curl --fail --silent --show-error \
       --max-time "$CURL_TIMEOUT" \
       --request "$method" \
       --header "Authorization: Bearer $TOKEN" \
       --header "Content-Type: application/json" \
       "${@:3}" \
       "$FK_ENCORE_URL$path"
}

stop_backup() {
  log "calling /internal/backup/stop"
  if ! call_api POST "/internal/backup/stop" --data '{}' >/dev/null; then
    log "WARN: /internal/backup/stop failed — the auto-stop safety timer inside the app will clean up"
    return 1
  fi
  return 0
}

# Trap: on ANY exit (success or failure after /start), try to /stop.
# The app's safety timer is a last-resort backstop if this also fails.
trap 'rc=$?; if [[ "${STARTED:-0}" == "1" ]]; then stop_backup || true; fi; exit $rc' EXIT

# -- 1. /start ------------------------------------------------------------
log "calling /internal/backup/start label=$LABEL"
START_BODY="$(jq -nc --arg label "$LABEL" '{label:$label}' 2>/dev/null || printf '{"label":"%s"}' "$LABEL")"
if ! START_RESP="$(call_api POST "/internal/backup/start" --data "$START_BODY")"; then
  log "FATAL: /internal/backup/start failed — aborting without snapshot"
  exit 2
fi
STARTED=1
log "/start ok: $START_RESP"

# -- 2. zfs snapshot -----------------------------------------------------
SNAP="${ZFS_DATASET}@${LABEL}"
log "creating ZFS snapshot $SNAP (recursive)"
if ! zfs snapshot -r "$SNAP"; then
  log "FATAL: zfs snapshot failed — /stop will be attempted via trap"
  exit 3
fi
log "zfs snapshot ok"

# -- 3. /stop -----------------------------------------------------------
# Handled by the trap; clear STARTED so the trap reports success.
if ! stop_backup; then
  exit 4
fi
STARTED=0
log "backup complete label=$LABEL"
