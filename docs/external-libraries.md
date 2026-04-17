# External Photo Libraries

External photo libraries let the backend import photos from directories on the
host filesystem instead of requiring every photo to go through the HTTP upload
endpoint. Two import modes are supported and libraries can optionally be
watched for live changes.

## Modes

| Mode   | What happens on import                                                                       | What happens on external delete                              |
| ------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `link` | File stays in place. The `photos` row stores the absolute path in `external_path`.           | The `photos` row is **hard-deleted** — no dead links remain. |
| `move` | File is moved into the standard `UPLOAD_DIR` layout (`YYYY/YYYY-MM/...`).                     | Nothing — the file is no longer external after the move.     |

Both modes deduplicate via SHA-256. Re-importing the same file for the same
owner is a no-op.

## Ownership & permissions

Library configuration is gated by the `photos.libraries.manage` permission.
The user who registers a library becomes the **owner** of every photo imported
from it, regardless of who triggers a later scan. This keeps ownership stable
across the scanner, the filesystem watcher, and the reconcile cron job.

## Required environment

| Variable                | Purpose                                                                                  | Default           |
| ----------------------- | ---------------------------------------------------------------------------------------- | ----------------- |
| `PHOTO_LIBRARIES_ROOT`  | Mandatory prefix. Every library path must live under this directory (enforced server-side). | `/mnt/libraries` |

Every path supplied to `POST /libraries` is resolved against
`PHOTO_LIBRARIES_ROOT` and rejected if it escapes it. This mirrors the existing
path-traversal guards on the photo-serving endpoint.

## Docker setup

Mount one host directory per library underneath `/mnt/libraries`. Use `:ro`
for `link`-mode libraries so the container can never mutate the originals:

```yaml
services:
  app:
    environment:
      PHOTO_LIBRARIES_ROOT: /mnt/libraries
    volumes:
      - photos:/mnt/data/photos
      - thumbnails:/mnt/data/thumbnails
      - /srv/photos/archive:/mnt/libraries/archive:ro   # link mode
      - /srv/photos/inbox:/mnt/libraries/inbox          # move mode
```

## REST API

All endpoints require authentication plus the `photos.libraries.manage`
permission.

### `POST /libraries`

Register a new library.

```json
{
  "name": "Family archive",
  "path": "archive",             // relative to PHOTO_LIBRARIES_ROOT, or absolute under it
  "import_mode": "link",         // "link" (default) or "move"
  "auto_import": true,           // optional; starts a chokidar watcher
  "auto_albums": false            // optional; see "Auto-albums" below
}
```

The `path` may point to any directory below `PHOTO_LIBRARIES_ROOT`, not only
a top-level mount. Use `GET /libraries/available-paths?sub=<rel-path>` to walk
the tree step by step: the response lists the sub-directories of the current
level, each annotated with whether it is already registered and whether it is
backed by its own mount.

Returns the created row. A watcher is booted immediately when
`auto_import = true`.

### `GET /libraries`

List all configured libraries.

### `GET /libraries/:id`

Fetch one library.

### `PATCH /libraries/:id`

Update name, import mode, `auto_import` or `auto_albums`. The watcher is
re-synced to match the new configuration. Toggling `auto_albums` only affects
future imports; already-imported photos are not retroactively sorted into
albums.

### `DELETE /libraries/:id`

Remove the registration. The watcher is stopped. Previously-imported photo
rows are **not** deleted — they keep pointing at `external_path` (for `link`)
or at the moved file under `UPLOAD_DIR` (for `move`). Purge them explicitly
via the regular hard-delete API if desired.

### `POST /libraries/:id/scan`

Walk the library once and import every supported file not already in the DB.
Returns a scan report:

```json
{
  "scanned": 1234,
  "imported": 17,
  "skipped_duplicate": 1217,
  "skipped_unsupported": 0,
  "errors": 0
}
```

### `POST /libraries/:id/reconcile`

Drop DB rows whose `external_path` has disappeared since the last scan.
Only meaningful for `link`-mode libraries. Returns `{ "removed": <n> }`.

## Automatic behaviour

- **Watcher** — when `auto_import = true`, a [chokidar](https://github.com/paulmillr/chokidar)
  instance watches the library directory. `add` events trigger an import;
  `unlink` events on a `link`-mode library hard-delete the matching photo
  row. Watchers use `awaitWriteFinish` so files copied over the network
  aren't imported half-written.
- **Hourly reconcile cron** — `library-reconcile` fires once per hour, walks
  every library, drops orphaned `link` rows, and runs a fresh scan to pick
  up anything the watcher missed (service restarts, network shares without
  inotify, etc.). Implemented with Encore's declarative `CronJob`.
- **Auto-albums** — when `auto_albums = true`, every imported photo that sits
  in a sub-directory of the library root is added to an album named after the
  **full relative sub-path** (forward-slash separated). Photos located
  directly in the library root are not auto-albumed. The album is owned by
  the library owner and created on first use; subsequent imports into the
  same sub-tree reuse it. Adding a photo to an album is idempotent, so
  re-scans and watcher events don't produce duplicates. Example: with library
  root `/mnt/libraries/archive`, the file `2020/2020-06 Wedding/IMG_0001.jpg`
  lands in album `2020/2020-06 Wedding`, distinct from `2020/2020-07`.
- **Event label** — when the last path segment of a new auto-album contains
  text beyond a date fragment (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`), the remainder
  is stored in `albums.event_name`. Example: `2020/2020-06 Wedding` yields
  `event_name = "Wedding"`; pure date folders like `2020/2020-06` leave it
  null. The field is only set at album creation time — manual edits made
  later are preserved.

## Data model

Migration `0022_photo_libraries.sql`:

```sql
CREATE TYPE library_import_mode AS ENUM ('link', 'move');
CREATE TABLE photo_libraries (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL UNIQUE,
  import_mode   library_import_mode NOT NULL DEFAULT 'link',
  auto_import   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMP DEFAULT NOW(),
  last_scan_at  TIMESTAMP
);

ALTER TABLE photos
  ADD COLUMN library_id    INTEGER REFERENCES photo_libraries(id) ON DELETE SET NULL,
  ADD COLUMN external_path TEXT;
```

Migration `0023_library_auto_albums.sql` adds the opt-in flag for the
auto-album feature:

```sql
ALTER TABLE photo_libraries
  ADD COLUMN auto_albums BOOLEAN NOT NULL DEFAULT false;
```

Migration `0024_album_event_name.sql` adds an optional event label on albums,
populated by the auto-album derivation (see above):

```sql
ALTER TABLE albums
  ADD COLUMN event_name TEXT;
```

`photos.filename` for link-imported rows follows the synthetic form
`__library/<library-id>/<basename>`. This is purely a routing key for the
`GET /photos/file/*filename` endpoint — the actual bytes are served from
`external_path`. Thumbnail cache keys include an MD5 suffix of the full
filename so basenames colliding between libraries don't share cached
variants.

## Operational notes

- **Read-only mounts** for `link` libraries are strongly recommended —
  the backend only reads them and it makes accidental mutation impossible.
- **Move mode across filesystem boundaries** — if the source and
  `UPLOAD_DIR` live on different filesystems, the scanner falls back from
  `rename(2)` to `copyFile` + `unlink` so the import still succeeds.
- **Hard-delete API** — `DELETE /photos/:id` on a `link`-imported photo
  removes the DB row but leaves the source file alone; on `move`- and
  upload-sourced photos it deletes the file as before.
- **Disabled libraries** — toggle `auto_import` to `false` via
  `PATCH /libraries/:id` to stop the watcher without unregistering. Manual
  scans still work.
