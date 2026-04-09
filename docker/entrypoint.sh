#!/usr/bin/env bash
set -euo pipefail

# Restrict default permissions for files/dirs created by the app:
#   files -> 0660 (rw-rw----)
#   dirs  -> 0770 (rwxrwx---)
umask 0007

APP_PORT="${PORT:-8080}"

exec encore run \
  --watch=false \
  --browser=never \
  --listen="0.0.0.0:${APP_PORT}"
