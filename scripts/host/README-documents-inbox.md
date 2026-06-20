# Document Inbox — Raspberry Pi Scanner Setup

The fk-encore documents module imports PDFs from
`DOCUMENTS_INBOX_DIR` (default `/mnt/data/documents-inbox` in the
container, bind-mounted via the `documents_inbox` volume in
`docker-compose.yml`). A `chokidar` watcher picks up any `*.pdf` that
stays stable for 5 seconds and runs the same import pipeline as the
UI upload endpoint (sha256 dedup → text extraction → AI
classification).

This document describes the recommended Raspberry Pi side of that
integration: a low-power Pi sits in the document workflow, listens to
the scan button (e.g. `scanbd` for SnapScan), produces a PDF, and
rsyncs it to the server.

## Why rsync (and not an HTTP upload)?

- The Pi can buffer locally if the server is offline or rebooting —
  rsync just retries on the next run.
- `--remove-source-files` deletes the file on the Pi only after the
  server has it, so duplicates are impossible.
- No API token is needed; SSH key auth with a `command=` restriction
  in `authorized_keys` keeps the attack surface tiny.

## Server-side preparation

1. Pick the host user that should own the inbox files. By default
   the container runs as UID/GID 568 (`apps`) on TrueNAS SCALE, so
   files dropped into `documents-inbox` need to be readable by that
   user. Either:
   - SSH into the host as a user whose primary group is `apps` (568),
     or
   - Drop files via SSH as a dedicated `scanner` user and set the
     directory's group + setgid bit so new files inherit group 568:
     ```
     sudo chown -R scanner:apps /Users/anton/f4mil_data/documents-inbox
     sudo chmod g+s /Users/anton/f4mil_data/documents-inbox
     ```

2. Add the Pi's SSH public key to the server user's
   `~/.ssh/authorized_keys`, restricted to rsync:

   ```
   command="rrsync -wo /Users/anton/f4mil_data/documents-inbox",no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAA…  pi-scanner
   ```

   `rrsync` ships with rsync (`/usr/share/doc/rsync/scripts/rrsync`).
   The `-wo` flag allows write-only access — the Pi can create new
   files but cannot list, read, or delete existing ones.

3. (Optional) Set `DOCUMENTS_INBOX_USER_EMAIL` in the app's env to
   the e-mail address of the user that should own the imported
   documents. Without it, the watcher falls back to the first Admin
   (ordered by user id).

## Pi-side script

Drop this into `/home/pi/after-scan.sh`, chmod +x, and have the scan
trigger (e.g. scanbd hook) call it after producing a PDF in
`/home/pi/scans/`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCAN_DIR=/home/pi/scans
SERVER_USER=scanner
SERVER_HOST=fk-encore.lan
SSH_KEY=/home/pi/.ssh/id_ed25519
SSH_OPTS="-i ${SSH_KEY} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

if ! ls "${SCAN_DIR}"/*.pdf >/dev/null 2>&1; then
  echo "no PDFs to upload"
  exit 0
fi

# --remove-source-files: delete only after a successful transfer.
# --partial: resume interrupted transfers on the next run.
# Trailing slash on the source dir means "contents of", not the dir
# itself.
rsync -av --remove-source-files --partial \
      -e "ssh ${SSH_OPTS}" \
      "${SCAN_DIR}/" \
      "${SERVER_USER}@${SERVER_HOST}:"

# rrsync writes into the configured root directly — no path needed.
```

## Verification

1. Drop a test PDF into `${SCAN_DIR}` and run `after-scan.sh`
   manually. The Pi log should show a successful `rsync` run and the
   file should disappear from `${SCAN_DIR}`.
2. On the server, the file should briefly appear in
   `/Users/anton/f4mil_data/documents-inbox/`, then be moved into
   `…/documents/YYYY/YYYY-MM/<sha256>.pdf` by the watcher.
3. The container log shows
   `[documents.inbox-watcher] imported foo.pdf → document <id>`.
4. The document then appears in the UI under `/dokumente`, status
   transitioning `pending → extracting → classifying → ready`.

## Troubleshooting

- `permission denied` on the Pi side: the server user can't write
  to `documents-inbox`. Check the chown/setgid on the host directory.
- File arrives but the watcher ignores it: the file extension must
  be `.pdf` (case-insensitive). Hidden files (starting with `.`) and
  non-PDF files are skipped on purpose so partial uploads do not
  trigger imports.
- `DuplicateDocumentError` log line: the server already has a
  document with the same sha256. The Pi-side file was deleted after
  the duplicate detection so the same scan does not keep re-firing.
- Watcher silent for new files: the inbox debounces uploads through
  `awaitWriteFinish` with a 5 s stability window
  (`DOCUMENTS_INBOX_STABILITY_MS`). A still-uploading file will not
  trigger until it has been quiet for at least that long.
