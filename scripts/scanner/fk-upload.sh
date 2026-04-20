#!/bin/bash
# fk-upload.sh — drain the scan spool into fk-encore's /documents endpoint.
#
# Invoked in two situations:
#   1. In the foreground by doscan.sh right after a successful scan.
#   2. Periodically by fk-upload.timer so files scanned while fk-encore
#      was unreachable eventually make it up.
#
# Concurrency: a single flock serialises both callers against each
# other. If a second invocation tries to enter while the first still
# holds the lock it exits with 0 — the first instance will drain the
# spool anyway and a missed wake-up is harmless.
#
# Auth: uses fk-encore's rotating refresh-token flow. The refresh token
# is exchanged for a short-lived access token, then the access token is
# used for the upload. Because /auth/refresh rotates the refresh token
# on every call, the new one is persisted atomically before any upload
# is attempted.
#
# Configuration (/etc/fk-scan/config or environment):
#   FK_ENCORE_URL         base URL of the fk-encore API (e.g. http://fk-encore.lan:4000)
#   FK_SCAN_SPOOL         spool directory (default /var/spool/fk-scan/pending)
#   FK_SCAN_TOKEN_FILE    refresh-token path (default /etc/fk-scan/refresh_token)
#   FK_CURL_TIMEOUT       per-HTTP-call timeout in seconds (default 120)

set -euo pipefail

CFG_FILE="${FK_SCAN_CONFIG:-/etc/fk-scan/config}"
# shellcheck disable=SC1090
[[ -r "$CFG_FILE" ]] && source "$CFG_FILE"

SPOOL_DIR="${FK_SCAN_SPOOL:-/var/spool/fk-scan/pending}"
TOKEN_FILE="${FK_SCAN_TOKEN_FILE:-/etc/fk-scan/refresh_token}"
BASE_URL="${FK_ENCORE_URL:-}"
CURL_TIMEOUT="${FK_CURL_TIMEOUT:-120}"
LOG_TAG="fk-scan/upload"

log()  { logger -t "$LOG_TAG" -- "$*"; echo "$(date +%F' '%T) $*"; }
err()  { logger -t "$LOG_TAG" -p user.err -- "$*"; echo "ERROR: $*" >&2; }

[[ -n "$BASE_URL" ]]     || { err "FK_ENCORE_URL not set (edit $CFG_FILE)"; exit 1; }
[[ -r "$TOKEN_FILE" ]]   || { err "refresh token file $TOKEN_FILE not readable"; exit 1; }
command -v jq >/dev/null || { err "jq is required but not installed"; exit 1; }

mkdir -p "$SPOOL_DIR"

# Serialise concurrent runs. Anyone holding the lock will process the
# whole spool, so a second concurrent invocation is simply redundant.
LOCK_FD=200
eval "exec $LOCK_FD>\"$SPOOL_DIR/.upload.lock\""
if ! flock -n "$LOCK_FD"; then
  log "another upload run is already active — skipping"
  exit 0
fi

shopt -s nullglob
pdfs=( "$SPOOL_DIR"/*.pdf )
if (( ${#pdfs[@]} == 0 )); then
  exit 0
fi

log "draining spool (${#pdfs[@]} file(s))"

resp=$(mktemp)
trap 'rm -f "$resp"' EXIT

# --- refresh access token --------------------------------------------
refresh_token=$(<"$TOKEN_FILE")
refresh_body=$(jq -n --arg t "$refresh_token" '{refreshToken:$t}')

http=$(curl --silent --show-error --max-time "$CURL_TIMEOUT" \
  --write-out '%{http_code}' --output "$resp" \
  -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/auth/refresh" \
  --data "$refresh_body" \
  || echo "000")

if [[ "$http" != "200" ]]; then
  err "auth refresh failed (HTTP $http): $(head -c 400 "$resp")"
  exit 1
fi

access_token=$(jq -r '.token'        < "$resp")
new_refresh=$(jq  -r '.refreshToken' < "$resp")

if [[ -z "$access_token" || "$access_token" == "null" ]] \
|| [[ -z "$new_refresh"  || "$new_refresh"  == "null" ]]; then
  err "auth refresh returned malformed payload"
  exit 1
fi

# Persist the rotated refresh token atomically so a crash between
# refresh and first upload does not leave the Pi unable to auth again.
umask 077
token_dir=$(dirname "$TOKEN_FILE")
tmp_token=$(mktemp "$token_dir/.refresh_token.XXXXXX")
printf '%s' "$new_refresh" > "$tmp_token"
mv "$tmp_token" "$TOKEN_FILE"

# --- upload each file, sequentially, abort on first failure ----------
# Sorting keeps chronological order (filenames are Scan-YYYY-MM-DD--HH.MM.SS.pdf).
IFS=$'\n' pdfs_sorted=($(printf '%s\n' "${pdfs[@]}" | sort))
unset IFS

failed=0
for pdf in "${pdfs_sorted[@]}"; do
  name=$(basename "$pdf")
  log "uploading $name ($(stat -c%s "$pdf") bytes)"

  http=$(curl --silent --show-error --max-time "$CURL_TIMEOUT" \
    --write-out '%{http_code}' --output "$resp" \
    -H "Authorization: Bearer $access_token" \
    -H "Content-Type: application/pdf" \
    -H "X-File-Name: $name" \
    --data-binary "@$pdf" \
    -X POST "$BASE_URL/documents" \
    || echo "000")

  case "$http" in
    201)
      log "uploaded $name (201)"
      rm -f "$pdf"
      ;;
    409)
      # Server already has this exact PDF (sha256 match). Safe to drop.
      log "duplicate $name (409) — already stored server-side, removing"
      rm -f "$pdf"
      ;;
    *)
      err "upload failed for $name (HTTP $http): $(head -c 400 "$resp")"
      failed=1
      # Preserve chronological order: stop on first failure.
      break
      ;;
  esac
done

exit "$failed"
