#!/usr/bin/env bash
#
# fk-encore daily backup driver.
#
# Runs on the TrueNAS SCALE host as root (via cron or a TrueNAS periodic
# task, once per day). Coordinates with the fk-encore app over HTTP so that
# the ZFS snapshot(s) taken in step 3 are application-consistent:
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
#        -> if today matches the weekly/monthly schedule (see
#           WEEKLY_SNAPSHOT_DOW / MONTHLY_SNAPSHOT_DOM below), one or two
#           additional recursive snapshots (weekly-*, monthly-*) are taken
#           right after, at the same point in time, while pg_backup_start()
#           is still in effect — no second pg_dump / prep cycle needed.
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
# Retention scheme (three independent tiers, one snapshot label prefix
# each — see "Snapshot tiers" below for how labels/timestamps are formed):
#
#   tier      label prefix   taken when                default retention
#   --------  -------------  -------------------------  -----------------
#   daily     daily-         every run                  14 days
#   weekly    weekly-        WEEKLY_SNAPSHOT_DOW matches  8 weeks (56 days)
#   monthly   monthly-       MONTHLY_SNAPSHOT_DOM matches 12 months (365 days)
#
# Configuration (env vars override defaults):
#   FK_ENCORE_URL           base URL of the app, default http://localhost:8080
#   FK_BACKUP_TOKEN_FILE    path to token file,  default: ./backup-token next to
#                           this script (that is where install-backup-hook.sh
#                           places it — on a ZFS dataset, upgrade-safe)
#   ZFS_DATASET             dataset for snapshot, default tank/f4mil
#   LABEL                   snapshot + dump label for the daily tier (also
#                           what /start / /stop and the pg_dump filename use),
#                           default daily-<UTC timestamp, %Y-%m-%d_%H-%M>
#   WEEKLY_SNAPSHOT_DOW     day of week (1=Monday .. 7=Sunday, ISO-8601,
#                           see `date +%u`) on which the weekly-* snapshot is
#                           additionally taken. Default 1 (Monday).
#   MONTHLY_SNAPSHOT_DOM    day of month (1-28) on which the monthly-*
#                           snapshot is additionally taken. Default 1 (1st).
#                           Keep this <=28 so it fires in every month.
#   CURL_TIMEOUT            seconds per HTTP call, default 60
#   READY_TIMEOUT_SEC       overall deadline for prep to reach phase=ready,
#                           default 7200 (2 h). Must be large enough for the
#                           slowest expected pg_dump + drain.
#   READY_POLL_INTERVAL_SEC poll cadence while waiting for phase=ready,
#                           default 10
#   DAILY_SNAPSHOT_RETENTION_DAYS    age in days above which `daily-*`
#                                     snapshots of $ZFS_DATASET are pruned
#                                     after a successful run. Default 14.
#   WEEKLY_SNAPSHOT_RETENTION_DAYS   same, for `weekly-*` snapshots.
#                                     Default 56 (8 weeks).
#   MONTHLY_SNAPSHOT_RETENTION_DAYS  same, for `monthly-*` snapshots.
#                                     Default 365 (12 months).
#                           Set any of the three to 0 to disable pruning for
#                           that tier. Only snapshots whose label starts with
#                           the matching prefix are ever considered — manual
#                           / ad-hoc snapshots, and snapshots taken by this
#                           run, are left alone. A prune failure is logged as
#                           WARN but does not fail the backup (the snapshot
#                           itself was taken successfully).
#   DUMP_DIR                host-side directory holding the pg_dump files
#                           (`encore-daily-*.dump`). Default: the parent of
#                           this script's directory, which matches the layout
#                           install-backup-hook.sh sets up (dumps live next
#                           to host-scripts/ on the backup volume). The dump
#                           itself is written by the app into $BACKUP_DIR
#                           (container path) before the snapshot is taken;
#                           this variable is only used for retention.
#   DUMP_RETENTION_DAYS     age in days above which `encore-daily-*.dump`
#                           files in $DUMP_DIR are deleted after a successful
#                           run. Default: same as DAILY_SNAPSHOT_RETENTION_DAYS,
#                           so a single override tunes both (only one pg_dump
#                           is taken per run, tied to the daily label — the
#                           weekly/monthly ZFS snapshots simply freeze a copy
#                           of it alongside the pgdata dataset, so they need
#                           no separate dump-retention setting). Set to 0 to
#                           disable. Other dumps (`pre-restore-*.dump`,
#                           `restored-*.dump`, operator-named files) are
#                           never touched. A prune failure is logged as WARN
#                           but does not fail the backup.
#
# Designed for bash 4+. Use `set -euo pipefail` so the trap-based /stop
# always runs on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FK_ENCORE_URL="${FK_ENCORE_URL:-http://localhost:8080}"
FK_BACKUP_TOKEN_FILE="${FK_BACKUP_TOKEN_FILE:-$SCRIPT_DIR/backup-token}"
ZFS_DATASET="${ZFS_DATASET:-tank/f4mil}"
TIMESTAMP="$(date -u +%Y-%m-%d_%H-%M)"
LABEL="${LABEL:-daily-$TIMESTAMP}"
WEEKLY_SNAPSHOT_DOW="${WEEKLY_SNAPSHOT_DOW:-1}"
MONTHLY_SNAPSHOT_DOM="${MONTHLY_SNAPSHOT_DOM:-1}"
CURL_TIMEOUT="${CURL_TIMEOUT:-60}"
READY_TIMEOUT_SEC="${READY_TIMEOUT_SEC:-7200}"
READY_POLL_INTERVAL_SEC="${READY_POLL_INTERVAL_SEC:-10}"
DAILY_SNAPSHOT_RETENTION_DAYS="${DAILY_SNAPSHOT_RETENTION_DAYS:-14}"
WEEKLY_SNAPSHOT_RETENTION_DAYS="${WEEKLY_SNAPSHOT_RETENTION_DAYS:-56}"
MONTHLY_SNAPSHOT_RETENTION_DAYS="${MONTHLY_SNAPSHOT_RETENTION_DAYS:-365}"
DUMP_DIR="${DUMP_DIR:-$(dirname "$SCRIPT_DIR")}"
DUMP_RETENTION_DAYS="${DUMP_RETENTION_DAYS:-$DAILY_SNAPSHOT_RETENTION_DAYS}"

for _var in WEEKLY_SNAPSHOT_DOW MONTHLY_SNAPSHOT_DOM \
            DAILY_SNAPSHOT_RETENTION_DAYS WEEKLY_SNAPSHOT_RETENTION_DAYS \
            MONTHLY_SNAPSHOT_RETENTION_DAYS DUMP_RETENTION_DAYS; do
  _val="${!_var}"
  if ! [[ "$_val" =~ ^[0-9]+$ ]]; then
    printf '[fk-encore-backup] FATAL: %s must be a non-negative integer, got %q\n' \
      "$_var" "$_val" >&2
    exit 1
  fi
done
unset _var _val

if (( WEEKLY_SNAPSHOT_DOW < 1 || WEEKLY_SNAPSHOT_DOW > 7 )); then
  printf '[fk-encore-backup] FATAL: WEEKLY_SNAPSHOT_DOW must be 1-7 (ISO weekday), got %q\n' \
    "$WEEKLY_SNAPSHOT_DOW" >&2
  exit 1
fi

if (( MONTHLY_SNAPSHOT_DOM < 1 || MONTHLY_SNAPSHOT_DOM > 28 )); then
  printf '[fk-encore-backup] FATAL: MONTHLY_SNAPSHOT_DOM must be 1-28 (to fire in every month), got %q\n' \
    "$MONTHLY_SNAPSHOT_DOM" >&2
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
  # Delete `<prefix>*` snapshots of $ZFS_DATASET older than N days. Manual /
  # unrelated snapshots, and snapshots of other tiers, are left untouched
  # (we only match the given label prefix). `zfs snapshot -r` on the root
  # dataset creates a snapshot with the same name on every child, so
  # destroying `<root>@<label>` with `-r` cascades across the whole tree.
  #
  # We enumerate snapshots on the root dataset only (no `-r`) to get one
  # row per label, regardless of how many child datasets carry a copy.
  local tier="$1" prefix="$2" retention_days="$3"
  if (( retention_days == 0 )); then
    log "$tier snapshot retention disabled (${tier^^}_SNAPSHOT_RETENTION_DAYS=0)"
    return 0
  fi

  local now_epoch cutoff_epoch
  now_epoch="$(date -u +%s)"
  cutoff_epoch=$(( now_epoch - retention_days * 86400 ))
  log "pruning ${prefix}* snapshots of $ZFS_DATASET older than ${retention_days}d (created before $(date -u -d "@$cutoff_epoch" +%FT%TZ))"

  local listing
  if ! listing="$(zfs list -H -p -o name,creation -t snapshot "$ZFS_DATASET" 2>&1)"; then
    log "WARN: zfs list failed, skipping prune: $listing"
    return 1
  fi

  local name creation label pruned=0 failed=0
  while IFS=$'\t' read -r name creation; do
    [[ -z "$name" ]] && continue
    label="${name#*@}"
    # Only prune labels this script owns. Never touch a snapshot taken by
    # this run (even if retention_days=0 would otherwise match in some
    # future caller — defensive) — see TAKEN_LABELS.
    [[ "$label" == "$prefix"* ]] || continue
    local is_own=0
    for taken in "${TAKEN_LABELS[@]}"; do
      [[ "$label" == "$taken" ]] && { is_own=1; break; }
    done
    (( is_own == 1 )) && continue
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

  log "$tier prune summary: destroyed=$pruned failed=$failed"
  (( failed == 0 ))
}

prune_old_dumps() {
  # Delete `encore-daily-*.dump` files in $DUMP_DIR older than N days.
  # The app writes a fresh dump into BACKUP_DIR on every successful run;
  # without this sweep the directory (and every future ZFS snapshot that
  # inherits it) grows without bound. Only files matching the daily-* name
  # this script's LABEL produces are eligible — `pre-restore-*.dump`,
  # `restored-*.dump` and operator-named ad-hoc dumps are left alone.
  local retention_days="$1"
  local dir="$2"
  if (( retention_days == 0 )); then
    log "dump retention disabled (DUMP_RETENTION_DAYS=0)"
    return 0
  fi
  if [[ ! -d "$dir" ]]; then
    log "WARN: dump dir $dir does not exist, skipping dump prune"
    return 1
  fi

  local now_epoch cutoff_epoch
  now_epoch="$(date -u +%s)"
  cutoff_epoch=$(( now_epoch - retention_days * 86400 ))
  log "pruning encore-daily-*.dump files in $dir older than ${retention_days}d (modified before $(date -u -d "@$cutoff_epoch" +%FT%TZ))"

  local file mtime deleted=0 failed=0
  # find -print0 / read -d '' to survive any path the operator might pick.
  # -maxdepth 1 keeps us out of subdirectories like host-scripts/ that may
  # also live under DUMP_DIR.
  while IFS= read -r -d '' file; do
    # Never delete the dump we just took this run, even if a misconfigured
    # clock somehow placed its mtime in the past. The cutoff already
    # protects us in any sane configuration; this is belt-and-suspenders.
    [[ "$(basename "$file")" == "encore-${LABEL}.dump" ]] && continue
    if ! mtime="$(stat -c %Y -- "$file" 2>/dev/null)"; then
      log "WARN: stat failed for $file"
      failed=$(( failed + 1 ))
      continue
    fi
    if (( mtime < cutoff_epoch )); then
      log "deleting $file (modified $(date -u -d "@$mtime" +%FT%TZ))"
      if rm -- "$file"; then
        deleted=$(( deleted + 1 ))
      else
        log "WARN: rm $file failed"
        failed=$(( failed + 1 ))
      fi
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name 'encore-daily-*.dump' -print0 2>/dev/null)

  log "dump prune summary: deleted=$deleted failed=$failed"
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
TAKEN_LABELS=("$LABEL")

# Additional tiers: taken at the same point in time (pg_backup_start() is
# still in effect), so they need no extra /start or pg_dump. Best-effort —
# a failure here does not fail the backup, since the daily snapshot (the
# one thing every run must produce) already succeeded.
DOW="$(date -u +%u)"
if (( 10#$DOW == 10#$WEEKLY_SNAPSHOT_DOW )); then
  WEEKLY_LABEL="weekly-$TIMESTAMP"
  WEEKLY_SNAP="${ZFS_DATASET}@${WEEKLY_LABEL}"
  log "day-of-week $DOW matches WEEKLY_SNAPSHOT_DOW — creating ZFS snapshot $WEEKLY_SNAP (recursive)"
  if zfs snapshot -r "$WEEKLY_SNAP"; then
    TAKEN_LABELS+=("$WEEKLY_LABEL")
  else
    log "WARN: weekly ZFS snapshot $WEEKLY_SNAP failed"
  fi
fi

DOM="$(date -u +%d)"
if (( 10#$DOM == 10#$MONTHLY_SNAPSHOT_DOM )); then
  MONTHLY_LABEL="monthly-$TIMESTAMP"
  MONTHLY_SNAP="${ZFS_DATASET}@${MONTHLY_LABEL}"
  log "day-of-month $DOM matches MONTHLY_SNAPSHOT_DOM — creating ZFS snapshot $MONTHLY_SNAP (recursive)"
  if zfs snapshot -r "$MONTHLY_SNAP"; then
    TAKEN_LABELS+=("$MONTHLY_LABEL")
  else
    log "WARN: monthly ZFS snapshot $MONTHLY_SNAP failed"
  fi
fi

# -- 4. /stop -----------------------------------------------------------
# Handled by the trap; clear STARTED so the trap reports success.
if ! stop_backup; then
  exit 4
fi
STARTED=0
log "backup complete label=$LABEL"

# -- 5. retention -------------------------------------------------------
# Prune best-effort: the backup itself already succeeded, a prune failure
# must not flip the overall exit code.
prune_old_snapshots daily   "daily-"   "$DAILY_SNAPSHOT_RETENTION_DAYS"   || true
prune_old_snapshots weekly  "weekly-"  "$WEEKLY_SNAPSHOT_RETENTION_DAYS"  || true
prune_old_snapshots monthly "monthly-" "$MONTHLY_SNAPSHOT_RETENTION_DAYS" || true
prune_old_dumps "$DUMP_RETENTION_DAYS" "$DUMP_DIR" || true
