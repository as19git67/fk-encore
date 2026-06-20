#!/usr/bin/env bash
#
# fk-encore backup log formatter.
#
# Reads the output of fk-encore-backup.sh (from stdin or a file) and emits a
# human-readable protocol followed by the raw log. Intended for the TrueNAS
# UI cron-mail so operators get a one-glance summary instead of a wall of
# timestamped lines.
#
# Usage:
#   # pipe mode (recommended for cron):
#   fk-encore-backup.sh 2>&1 | format-backup-log.sh
#
#   # file mode (for one-off inspection of a captured log):
#   format-backup-log.sh /path/to/backup.log
#
# Propagating the backup script's exit code through the pipe requires
# `set -o pipefail` in the caller (or $PIPESTATUS). The TrueNAS cron-job
# command line should therefore be wrapped in bash -c, e.g.:
#
#   bash -c 'set -o pipefail; ZFS_DATASET=tank/f4mil \
#       /mnt/tank/f4mil/backup/host-scripts/fk-encore-backup.sh 2>&1 \
#       | /mnt/tank/f4mil/backup/host-scripts/format-backup-log.sh'
#
# Design notes:
#   - The formatter is best-effort. Any line it does not recognise is still
#     included verbatim in the raw-log section at the bottom, so nothing is
#     ever silently dropped.
#   - We buffer the whole log in memory before emitting. Backup logs are
#     tens of lines at most, so that cost is negligible, and it lets us put
#     the summary *above* the raw log — which is where a human wants it.
#   - The formatter itself never exits non-zero on unexpected input (only
#     on usage errors). If the backup failed, the summary will say so;
#     pipefail in the caller is what surfaces the failure as an exit code.

set -u

usage() {
  sed -n '3,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

# --- input ------------------------------------------------------------------
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -) raw="$(cat)" ;;
    *)
      if [[ ! -r "$1" ]]; then
        printf 'format-backup-log: cannot read %s\n' "$1" >&2
        exit 2
      fi
      raw="$(cat -- "$1")"
      ;;
  esac
else
  raw="$(cat)"
fi

# --- parse ------------------------------------------------------------------
label=""
first_ts=""
last_ts=""
start_call_ts=""
start_accept_ts=""
ready_ts=""
snap_create_ts=""
snap_name=""
snap_ok=0
stop_called_ts=""
complete_ts=""
complete=0
prune_started=0
prune_cutoff=""
prune_disabled=0
prune_destroyed_count=""
prune_failed_count=""
destroyed_lines=()      # "ts|name|created"
dump_prune_started=0
dump_prune_cutoff=""
dump_prune_dir=""
dump_prune_disabled=0
dump_prune_deleted_count=""
dump_prune_failed_count=""
dump_deleted_lines=()   # "ts|file|modified"
warnings=()             # "ts  message"
fatals=()               # "ts  message"
other_steps=()          # "ts|description"

# Line pattern: [fk-encore-backup <ISO>] <rest>
line_re='^\[fk-encore-backup[[:space:]]+([0-9T:Z.+-]+)\][[:space:]](.*)$'

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if [[ ! "$line" =~ $line_re ]]; then
    continue
  fi
  ts="${BASH_REMATCH[1]}"
  msg="${BASH_REMATCH[2]}"

  [[ -z "$first_ts" ]] && first_ts="$ts"
  last_ts="$ts"

  case "$msg" in
    WARN:*)  warnings+=("$ts  ${msg#WARN: }") ;;
    FATAL:*) fatals+=("$ts  ${msg#FATAL: }") ;;
  esac

  if [[ "$msg" =~ ^calling\ /internal/backup/start\ label=(.+)$ ]]; then
    label="${BASH_REMATCH[1]}"
    start_call_ts="$ts"
  elif [[ "$msg" == /start\ accepted:* ]]; then
    start_accept_ts="$ts"
  elif [[ "$msg" == prep\ ready:* ]]; then
    ready_ts="$ts"
  elif [[ "$msg" =~ ^creating\ ZFS\ snapshot\ ([^[:space:]]+) ]]; then
    snap_create_ts="$ts"
    snap_name="${BASH_REMATCH[1]}"
  elif [[ "$msg" == "zfs snapshot ok" ]]; then
    snap_ok=1
  elif [[ "$msg" == "calling /internal/backup/stop" ]]; then
    stop_called_ts="$ts"
  elif [[ "$msg" =~ ^backup\ complete ]]; then
    complete_ts="$ts"
    complete=1
  elif [[ "$msg" =~ ^pruning\ daily-\*.*before\ ([0-9T:Z.+-]+)\) ]]; then
    prune_started=1
    prune_cutoff="${BASH_REMATCH[1]}"
  elif [[ "$msg" == "snapshot retention disabled"* ]]; then
    prune_disabled=1
  elif [[ "$msg" =~ ^destroying\ ([^[:space:]]+)\ \(created\ ([0-9T:Z.+-]+)\) ]]; then
    destroyed_lines+=("$ts|${BASH_REMATCH[1]}|${BASH_REMATCH[2]}")
  elif [[ "$msg" =~ ^prune\ summary:\ destroyed=([0-9]+)\ failed=([0-9]+) ]]; then
    prune_destroyed_count="${BASH_REMATCH[1]}"
    prune_failed_count="${BASH_REMATCH[2]}"
  elif [[ "$msg" =~ ^pruning\ encore-daily-\*\.dump\ files\ in\ (.+)\ older\ than\ .*modified\ before\ ([0-9T:Z.+-]+)\) ]]; then
    dump_prune_started=1
    dump_prune_dir="${BASH_REMATCH[1]}"
    dump_prune_cutoff="${BASH_REMATCH[2]}"
  elif [[ "$msg" == "dump retention disabled"* ]]; then
    dump_prune_disabled=1
  elif [[ "$msg" =~ ^deleting\ (.+)\ \(modified\ ([0-9T:Z.+-]+)\) ]]; then
    dump_deleted_lines+=("$ts|${BASH_REMATCH[1]}|${BASH_REMATCH[2]}")
  elif [[ "$msg" =~ ^dump\ prune\ summary:\ deleted=([0-9]+)\ failed=([0-9]+) ]]; then
    dump_prune_deleted_count="${BASH_REMATCH[1]}"
    dump_prune_failed_count="${BASH_REMATCH[2]}"
  fi
done <<< "$raw"

# --- helpers ----------------------------------------------------------------
iso_to_epoch() {
  [[ -z "$1" ]] && return 1
  date -u -d "$1" +%s 2>/dev/null
}

pretty_ts() {
  # 2026-04-20T03:00:02Z -> 2026-04-20 03:00:02 UTC
  local t="${1:-}"
  [[ -z "$t" ]] && { printf -- "-"; return; }
  t="${t/T/ }"
  printf '%s' "${t%Z} UTC"
}

short_time() {
  # 2026-04-20T03:00:02Z -> 03:00:02
  local t="${1:-}"
  [[ -z "$t" ]] && { printf -- "--:--:--"; return; }
  t="${t#*T}"
  printf '%s' "${t%Z}"
}

duration_human() {
  local d="$1" h m s
  (( d < 0 )) && { printf -- "-"; return; }
  h=$(( d / 3600 ))
  m=$(( (d % 3600) / 60 ))
  s=$(( d % 60 ))
  if (( h > 0 ));   then printf '%dh %dm %ds' "$h" "$m" "$s"
  elif (( m > 0 )); then printf '%dm %ds'     "$m" "$s"
  else                   printf '%ds'               "$s"
  fi
}

# --- derive status & duration -----------------------------------------------
duration=""
if [[ -n "$first_ts" && -n "$last_ts" ]]; then
  start_e=$(iso_to_epoch "$first_ts" || true)
  end_e=$(iso_to_epoch "$last_ts" || true)
  if [[ -n "${start_e:-}" && -n "${end_e:-}" ]]; then
    duration="$(duration_human $(( end_e - start_e )))"
  fi
fi

if (( ${#fatals[@]} > 0 )); then
  status="FEHLGESCHLAGEN"
elif (( complete == 1 && snap_ok == 1 )); then
  status="Erfolg"
else
  status="Unvollständig"
fi

# --- emit -------------------------------------------------------------------
SEP="================================================================"

{
  echo "$SEP"
  echo "fk-encore Backup-Protokoll"
  echo "$SEP"
  printf '%-10s %s\n' "Label:"  "${label:-<unbekannt>}"
  printf '%-10s %s\n' "Start:"  "$(pretty_ts "$first_ts")"
  printf '%-10s %s\n' "Ende:"   "$(pretty_ts "$last_ts")"
  printf '%-10s %s\n' "Dauer:"  "${duration:-<unbekannt>}"
  printf '%-10s %s\n' "Status:" "$status"
  echo

  echo "Schritte:"
  [[ -n "$start_call_ts"   ]] && printf '  %s  Start angefordert (/internal/backup/start)\n'  "$(short_time "$start_call_ts")"
  [[ -n "$start_accept_ts" ]] && printf '  %s  Start akzeptiert, Vorbereitung läuft\n'        "$(short_time "$start_accept_ts")"
  [[ -n "$ready_ts"        ]] && printf '  %s  Vorbereitung fertig (pg_dump abgeschlossen)\n' "$(short_time "$ready_ts")"
  if [[ -n "$snap_create_ts" ]]; then
    if (( snap_ok == 1 )); then
      printf '  %s  ZFS-Snapshot erstellt: %s\n' "$(short_time "$snap_create_ts")" "$snap_name"
    else
      printf '  %s  ZFS-Snapshot FEHLGESCHLAGEN: %s\n' "$(short_time "$snap_create_ts")" "$snap_name"
    fi
  fi
  [[ -n "$stop_called_ts" ]] && printf '  %s  Stop aufgerufen (/internal/backup/stop)\n'      "$(short_time "$stop_called_ts")"
  [[ -n "$complete_ts"    ]] && printf '  %s  Backup abgeschlossen\n'                         "$(short_time "$complete_ts")"
  echo

  if (( prune_started == 1 )) || [[ -n "$prune_destroyed_count" ]]; then
    echo "Snapshot-Pruning:"
    [[ -n "$prune_cutoff" ]] && printf '  Schwelle:  älter als %s\n' "$(pretty_ts "$prune_cutoff")"
    if (( ${#destroyed_lines[@]} > 0 )); then
      echo "  Gelöscht:"
      for entry in "${destroyed_lines[@]}"; do
        IFS='|' read -r _ name created <<< "$entry"
        printf '    - %s  (erstellt %s)\n' "$name" "$(pretty_ts "$created")"
      done
    fi
    if [[ -n "$prune_destroyed_count" || -n "$prune_failed_count" ]]; then
      printf '  Summary:   destroyed=%s failed=%s\n' "${prune_destroyed_count:-?}" "${prune_failed_count:-?}"
    fi
    echo
  elif (( prune_disabled == 1 )); then
    echo "Snapshot-Pruning: deaktiviert (SNAPSHOT_RETENTION_DAYS=0)"
    echo
  fi

  if (( dump_prune_started == 1 )) || [[ -n "$dump_prune_deleted_count" ]]; then
    echo "Dump-Pruning:"
    [[ -n "$dump_prune_dir"    ]] && printf '  Verzeichnis: %s\n' "$dump_prune_dir"
    [[ -n "$dump_prune_cutoff" ]] && printf '  Schwelle:    älter als %s\n' "$(pretty_ts "$dump_prune_cutoff")"
    if (( ${#dump_deleted_lines[@]} > 0 )); then
      echo "  Gelöscht:"
      for entry in "${dump_deleted_lines[@]}"; do
        IFS='|' read -r _ file modified <<< "$entry"
        printf '    - %s  (geändert %s)\n' "$file" "$(pretty_ts "$modified")"
      done
    fi
    if [[ -n "$dump_prune_deleted_count" || -n "$dump_prune_failed_count" ]]; then
      printf '  Summary:     deleted=%s failed=%s\n' "${dump_prune_deleted_count:-?}" "${dump_prune_failed_count:-?}"
    fi
    echo
  elif (( dump_prune_disabled == 1 )); then
    echo "Dump-Pruning: deaktiviert (DUMP_RETENTION_DAYS=0)"
    echo
  fi

  if (( ${#fatals[@]} > 0 )); then
    echo "Fehler (FATAL):"
    for entry in "${fatals[@]}"; do
      printf '  %s\n' "$entry"
    done
    echo
  fi
  if (( ${#warnings[@]} > 0 )); then
    echo "Warnungen:"
    for entry in "${warnings[@]}"; do
      printf '  %s\n' "$entry"
    done
    echo
  fi
  if (( ${#fatals[@]} == 0 && ${#warnings[@]} == 0 )); then
    echo "Warnungen/Fehler: keine"
    echo
  fi

  echo "$SEP"
  echo "Roh-Log"
  echo "$SEP"
  printf '%s\n' "$raw"
}
