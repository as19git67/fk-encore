#!/usr/bin/env bash
#
# fk-encore daily backup driver.
#
# Runs on the TrueNAS SCALE host as root (via cron or a TrueNAS periodic
# task). Coordinates with the fk-encore app over HTTP so that the ZFS
# snapshot taken in step 3 is application-consistent:
#
#   1. POST /internal/backup/start
#        -> app returns 202 immediately and begins prep in the background:
#           pauses scan workers, calls pg_backup_start(), writes pg_dump
#           to $BACKUP_DIR/encore-$LABEL.dump
#   2. Poll GET /internal/backup/status until phase=ready (or phase=failed).
#        -> this decouples the HTTP request timeout from the (potentially
#           minute-long) pg_dump on the server.
#   3. zfs snapshot -r $ZFS_DATASET@$LABEL
#        -> host-side snapshot, captures pgdata + photos consistently
#        -> the pg_dump from step 1 is inside the snapshot too
#   4. POST /internal/backup/stop
#        -> app calls pg_backup_stop(), resumes scan workers, leaves
#           maintenance mode
#
# Exit codes:
#   0  success
#   1  pre-flight failure (missing token / API unreachable)
#   2  /start failed
#   3  zfs snapshot failed (attempts /stop before exiting)
#   4  /stop failed
#   5  /start prep timed out or failed (no phase=ready within deadline)
#
# Configuration (env vars override defaults):
#   FK_ENCORE_URL           base URL of the app, default http://localhost:8080
#   FK_BACKUP_TOKEN_FILE    path to token file,  default: ./backup-token next to
#                           this script (that is where install-backup-hook.sh
#                           places it — on a ZFS dataset, upgrade-safe)
#   ZFS_DATASET             dataset for snapshot, default tank/vivanty
#   LABEL                   snapshot + dump label, default daily-<UTC timestamp>
#   CURL_TIMEOUT            seconds per HTTP call, default 30
#   READY_TIMEOUT_SEC       overall deadline for prep to reach phase=ready,
#                           default 3600 (1 h). Must be large enough for the
#                           slowest expected pg_dump + drain.
#   READY_POLL_INTERVAL_SEC poll cadence while waiting for phase=ready,
#                           default 5
#   SNAPSHOT_RETENTION_DAYS age in days above which `daily-*` snapshots of
#                           $ZFS_DATASET are pruned after a successful run.
#                           Default 30. Set to 0 to disable pruning. Only
#                           snapshots whose label starts with `daily-` are
#                           ever considered — manual / ad-hoc snapshots are
#                           left alone. A prune failure is logged as WARN
#                           but does not fail the backup (the snapshot
#                           itself was taken successfully).
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
READY_TIMEOUT_SEC="${READY_TIMEOUT_SEC:-3600}"
READY_POLL_INTERVAL_SEC="${READY_POLL_INTERVAL_SEC:-5}"
SNAPSHOT_RETENTION_DAYS="${SNAPSHOT_RETENTION_DAYS:-30}"

if ! [[ "$SNAPSHOT_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  printf '[fk-encore-backup] FATAL: SNAPSHOT_RETENTION_DAYS must be a non-negative integer, got %q\n' \
    "$SNAPSHOT_RETENTION_DAYS" >&2
  exit 1
fi

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
  # Usage: call_api METHOD PATH [extra curl args...]
  # Prints the response body on stdout when the HTTP status is 2xx.
  # On non-2xx, logs "HTTP <status>: <body>" to stderr and returns 1. Without
  # this, curl --fail hides the body, making 401 / 400 responses opaque on
  # the host.
  local method="$1" path="$2"
  local tmp_body http_status
  tmp_body="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp_body'" RETURN

  http_status="$(
    curl --silent --show-error \
         --max-time "$CURL_TIMEOUT" \
         --request "$method" \
         --header "Authorization: Bearer $TOKEN" \
         --header "Content-Type: application/json" \
         --output "$tmp_body" \
         --write-out '%{http_code}' \
         "${@:3}" \
         "$FK_ENCORE_URL$path" || true
  )"

  if [[ "$http_status" =~ ^2[0-9][0-9]$ ]]; then
    cat "$tmp_body"
    return 0
  fi

  log "HTTP $http_status from $method $path: $(tr -d '\n' < "$tmp_body")"
  return 1
}

# Extract the top-level value of a JSON string field via the most portable
# mechanism available. Falls back to a grep/sed scrape so we do not add a
# jq hard-dep (jq is still *preferred* when present for correctness).
json_field() {
  local field="$1" body="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r --arg f "$field" '.[$f] // empty'
    return
  fi
  # Matches  "field": "value"  or  "field":null  — returns empty for null.
  printf '%s' "$body" \
    | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -n1 \
    | sed -E 's/^"[^"]+"[[:space:]]*:[[:space:]]*"([^"]*)"$/\1/'
}

# Poll /internal/backup/status every READY_POLL_INTERVAL_SEC until:
#   phase=ready   -> return 0
#   phase=failed  -> return 1 (error logged from status body)
#   deadline hit  -> return 2 (timeout; caller exits 5 and /stop trap fires)
wait_until_ready() {
  local deadline
  deadline=$(( $(date -u +%s) + READY_TIMEOUT_SEC ))

  while true; do
    local status_body phase error
    if ! status_body="$(call_api GET /internal/backup/status)"; then
      log "WARN: /internal/backup/status call failed; will retry"
    else
      phase="$(json_field phase "$status_body")"
      case "$phase" in
        ready)
          log "prep ready: $status_body"
          return 0
          ;;
        failed)
          error="$(json_field error "$status_body")"
          log "FATAL: prep failed: ${error:-<no error detail>}"
          return 1
          ;;
        draining|dumping|stopping)
          # still working — keep polling
          ;;
        idle|"")
          log "WARN: unexpected phase=${phase:-<empty>} while waiting for ready — body=$status_body"
          ;;
        *)
          log "WARN: unknown phase=$phase — body=$status_body"
          ;;
      esac
    fi

    if (( $(date -u +%s) >= deadline )); then
      log "FATAL: prep did not reach phase=ready within ${READY_TIMEOUT_SEC}s"
      return 2
    fi
    sleep "$READY_POLL_INTERVAL_SEC"
  done
}

stop_backup() {
  log "calling /internal/backup/stop"
  if ! call_api POST "/internal/backup/stop" --data '{}' >/dev/null; then
    log "WARN: /internal/backup/stop failed — the auto-stop safety timer inside the app will clean up"
    return 1
  fi
  return 0
}

prune_old_snapshots() {
  # Delete `daily-*` snapshots of $ZFS_DATASET older than N days. Manual /
  # unrelated snapshots are left untouched (we only match the label prefix
  # this script itself generates). `zfs snapshot -r` on the root dataset
  # creates a snapshot with the same name on every child, so destroying
  # `<root>@<label>` with `-r` cascades across the whole tree.
  #
  # We enumerate snapshots on the root dataset only (no `-r`) to get one
  # row per label, regardless of how many child datasets carry a copy.
  local retention_days="$1"
  if (( retention_days == 0 )); then
    log "snapshot retention disabled (SNAPSHOT_RETENTION_DAYS=0)"
    return 0
  fi

  local now_epoch cutoff_epoch
  now_epoch="$(date -u +%s)"
  cutoff_epoch=$(( now_epoch - retention_days * 86400 ))
  log "pruning daily-* snapshots of $ZFS_DATASET older than ${retention_days}d (created before $(date -u -d "@$cutoff_epoch" +%FT%TZ))"

  local listing
  if ! listing="$(zfs list -H -p -o name,creation -t snapshot "$ZFS_DATASET" 2>&1)"; then
    log "WARN: zfs list failed, skipping prune: $listing"
    return 1
  fi

  local name creation label pruned=0 failed=0
  while IFS=$'\t' read -r name creation; do
    [[ -z "$name" ]] && continue
    label="${name#*@}"
    # Only prune labels this script owns. Never touch the snapshot we just
    # took (even if retention_days=0 would otherwise match in some future
    # caller — defensive).
    [[ "$label" == daily-* ]] || continue
    [[ "$label" == "$LABEL" ]] && continue
    if (( creation < cutoff_epoch )); then
      log "destroying $name (created $(date -u -d "@$creation" +%FT%TZ))"
      if zfs destroy -r "$name"; then
        pruned=$(( pruned + 1 ))
      else
        log "WARN: zfs destroy -r $name failed"
        failed=$(( failed + 1 ))
      fi
    fi
  done <<< "$listing"

  log "prune summary: destroyed=$pruned failed=$failed"
  (( failed == 0 ))
}

# Trap: on ANY exit (success or failure after /start), try to /stop.
# The app's safety timer is a last-resort backstop if this also fails.
trap 'rc=$?; if [[ "${STARTED:-0}" == "1" ]]; then stop_backup || true; fi; exit $rc' EXIT

# -- 1. /start ------------------------------------------------------------
# The endpoint returns 202 immediately after arming maintenance mode; the
# actual pauseWorkers / pg_backup_start / pg_dump sequence runs in the
# background on the app side.
log "calling /internal/backup/start label=$LABEL"
START_BODY="$(jq -nc --arg label "$LABEL" '{label:$label}' 2>/dev/null || printf '{"label":"%s"}' "$LABEL")"
if ! START_RESP="$(call_api POST "/internal/backup/start" --data "$START_BODY")"; then
  log "FATAL: /internal/backup/start failed — aborting without snapshot"
  exit 2
fi
STARTED=1
log "/start accepted: $START_RESP"

# -- 2. poll /status until phase=ready -----------------------------------
if ! wait_until_ready; then
  case "$?" in
    1) log "FATAL: prep failed server-side — /stop will be attempted via trap"; exit 5 ;;
    2) log "FATAL: prep timeout — /stop will be attempted via trap"; exit 5 ;;
  esac
fi

# -- 3. zfs snapshot -----------------------------------------------------
SNAP="${ZFS_DATASET}@${LABEL}"
log "creating ZFS snapshot $SNAP (recursive)"
if ! zfs snapshot -r "$SNAP"; then
  log "FATAL: zfs snapshot failed — /stop will be attempted via trap"
  exit 3
fi
log "zfs snapshot ok"

# -- 4. /stop -----------------------------------------------------------
# Handled by the trap; clear STARTED so the trap reports success.
if ! stop_backup; then
  exit 4
fi
STARTED=0
log "backup complete label=$LABEL"

# -- 4. retention -------------------------------------------------------
# Prune best-effort: the backup itself already succeeded, a prune failure
# must not flip the overall exit code.
prune_old_snapshots "$SNAPSHOT_RETENTION_DAYS" || true
