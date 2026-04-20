#!/bin/bash
# doscan.sh — scanbd action script that hands scanned PDFs to fk-encore.
#
# Invoked by scanbd as saned:scanner when the ScanSnap button is pressed.
# Flow:
#   1. If the spool still holds files from an earlier scan (upload to
#      fk-encore has not succeeded yet), refuse: the button press becomes
#      a no-op until the retry timer has drained the spool. This enforces
#      "no new scan until the last one is safely stored".
#   2. Otherwise: scan to PDF into the spool (no OCR, no post-processing
#      — fk-encore's documents service handles all of that), then try a
#      foreground upload. A failed upload leaves the PDF in the spool;
#      fk-upload.timer will keep retrying.
#
# Configuration (override via /etc/fk-scan/config or the environment):
#   FK_SCAN_SPOOL     directory for pending PDFs (default /var/spool/fk-scan/pending)
#   FK_SCAN_BIN       path to the sane-scan-pdf `scan` wrapper
#   FK_SCAN_ARGS      scan CLI arguments (default matches fujitsu ScanSnap A4 300dpi Lineart)
#   FK_UPLOAD_CMD     upload worker (default /usr/local/bin/fk-upload.sh)

set -euo pipefail

CFG_FILE="${FK_SCAN_CONFIG:-/etc/fk-scan/config}"
# shellcheck disable=SC1090
[[ -r "$CFG_FILE" ]] && source "$CFG_FILE"

SPOOL_DIR="${FK_SCAN_SPOOL:-/var/spool/fk-scan/pending}"
SCAN_BIN="${FK_SCAN_BIN:-/home/anton/sane-scan-pdf/scan}"
SCAN_ARGS="${FK_SCAN_ARGS:--d -x fujitsu -s A4 -r 300 -v -m Lineart --autorotate --skip-empty-pages}"
UPLOAD_CMD="${FK_UPLOAD_CMD:-/usr/local/bin/fk-upload.sh}"
LOG_TAG="fk-scan/doscan"

log()  { logger -t "$LOG_TAG" -- "$*"; echo "$(date +%F' '%T) $*"; }
fail() { logger -t "$LOG_TAG" -p user.err -- "$*"; echo "ERROR: $*" >&2; exit 1; }

mkdir -p "$SPOOL_DIR"

# --- block if previous scan is still pending upload -------------------
shopt -s nullglob
pending=( "$SPOOL_DIR"/*.pdf )
if (( ${#pending[@]} > 0 )); then
  log "refusing scan: ${#pending[@]} file(s) still pending upload — button ignored"
  # Nothing to do: new button press will simply hit this guard again.
  # The next successful fk-upload run will clear the spool and re-arm.
  exit 0
fi

# --- scan -------------------------------------------------------------
ts=$(date +%Y-%m-%d--%H.%M.%S)
out="$SPOOL_DIR/Scan-$ts.pdf"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

log "scanning → $out"

# Pause scanbd button polling for the duration of the scan so a second
# press mid-scan does not queue up a duplicate job.
scanbd_pid=$(pgrep -x scanbd || true)
if [[ -n "$scanbd_pid" ]]; then
  kill -SIGUSR1 "$scanbd_pid" || true
fi

# shellcheck disable=SC2086  # deliberate word-splitting of SCAN_ARGS
if ! "$SCAN_BIN" $SCAN_ARGS -o "$tmp/scan.pdf"; then
  [[ -n "$scanbd_pid" ]] && kill -SIGUSR2 "$scanbd_pid" || true
  fail "scan command failed"
fi

if [[ -n "$scanbd_pid" ]]; then
  kill -SIGUSR2 "$scanbd_pid" || true
fi

[[ -r "$tmp/scan.pdf" ]] || fail "scan produced no output file"

# Atomic move into the spool: the upload worker will never see a half-
# written PDF because rename(2) is atomic within a filesystem.
mv "$tmp/scan.pdf" "$out"
log "scan stored: $out ($(stat -c%s "$out") bytes)"

# --- try upload in the foreground -------------------------------------
if "$UPLOAD_CMD"; then
  log "upload ok"
else
  log "upload failed — will retry via fk-upload.timer"
fi
