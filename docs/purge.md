# Photo Purge: Delete All Photo Data

## Summary

The purge flow **irreversibly** removes every photo-related piece of data
from an installation – photos, albums, faces, persons, embeddings, scan
queue entries, and (optionally) the original files and the thumbnail cache
as well. User accounts, roles, and permissions are preserved.

The feature is implemented as a **Danger Zone** in the data management
view and is protected against accidental invocation by a dedicated
permission (`photos.purge`) and a typed confirmation (`LÖSCHEN`, the
German word for "delete", used verbatim in the German UI).

## When should you purge?

Typical use cases:

- **Fresh test / demo environment** without rebuilding the container.
- **Full reset** before re-importing a curated library.
- **Cleaning up orphaned embeddings** after a failed migration or backup
  operation.

> For selectively removing individual photos, the regular
> `DELETE /photos/:id` endpoint with `photos.delete` is still available.
> Purge is explicitly the "start over from scratch" button.

## Permission model

```
permissions
└── photos.purge   -- "Purge all photo-related data (destructive)"
```

| Role            | `photos.purge`            |
|-----------------|---------------------------|
| Admin           | **NOT** assigned by default |
| User            | not assigned               |
| (custom role)   | can be granted manually    |

`photos.purge` is explicitly excluded from the default assignment of the
Admin role in [`db/seed.ts`](../db/seed.ts) (`adminExcludedPermissions`).
This is a deliberate safety measure: even an Admin can only purge after a
second Admin (or the same person, as a deliberate act) has granted the
permission to a role. The seed job additionally performs a defensive
cleanup and revokes the permission from the Admin role if it had been
granted in earlier versions.

The frontend UI checks `auth.hasPermission('photos.purge')` and hides the
entire "Danger Zone" block for users without this permission.

## API

### Endpoint

```
POST /photos/purge        (auth required, permission: photos.purge)
Content-Type: application/json

{ "deleteFiles": false }
```

| Field         | Type      | Meaning                                                   |
|---------------|-----------|-----------------------------------------------------------|
| `deleteFiles` | `boolean` | `true` = also delete original files and thumbnail cache. `false` = empty the database only; files remain on disk (orphaned). |

### Response

```jsonc
{
  "success": true,
  "dbCounts": {
    "photo_scan_queue": 12,
    "photo_landmarks": 84,
    "user_face_assignments": 31,
    "faces": 119,
    "photo_group_members": 22,
    "photo_groups": 7,
    "album_photos": 156,
    "album_shares": 4,
    "album_public_links": 0,
    "album_user_settings": 9,
    "albums": 11,
    "persons": 8,
    "photo_curation": 84,
    "photos": 412
  },
  "files": {
    "deleted": true,           // == the submitted deleteFiles value
    "uploadsRemoved": 412,
    "thumbnailsRemoved": 412,
    "failures": 0
  },
  "embeddingService": {
    "called": true,
    "ok": true,
    "deleted": 412,
    "error": ""
  }
}
```

`dbCounts` lists the number of deleted rows per table in the
**order of actual execution**, which makes later diagnostics easier
(e.g. for an unexpectedly empty table).

`embeddingService` is **always** called – even when `deleteFiles=false`.
Once the `photos` table is empty, the embeddings in the vector store are
orphaned anyway. If the call fails (service unreachable, etc.), the
error is reported in the response field, but the DB part of the purge
is still considered successful.

## Implementation

### Backend layers

| File                                                                                                     | Role                                                                  |
|----------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------|
| [`photo/photo.ts`](../photo/photo.ts) `purgePhotos`                                                      | Encore.ts endpoint; checks auth + permission and delegates to the logic. |
| [`photo/photo.service.ts`](../photo/photo.service.ts) `purgeAllPhotosLogic`                              | Actual delete sequence, FK-safe order, file and embedding cleanup.    |
| [`embedding_service/app/api/endpoints.py`](../embedding_service/app/api/endpoints.py) `delete_all_photos` | Python endpoint `DELETE /photos`; clears the pgvector store.          |

### Delete order (FK-safe)

Inside `purgeAllPhotosLogic`, tables are emptied in an order that respects
all foreign-key dependencies (children before parents):

```
photo_scan_queue
photo_landmarks
user_face_assignments
faces
photo_group_members
photo_groups
album_photos
album_shares
album_public_links
album_user_settings
albums
persons
photo_curation
photos
```

Afterwards:

1. `DELETE` call against the embedding service (`/photos`).
2. Reset the internal `_aiUserId` cache so the next lookup gets a fresh
   value.
3. If `deleteFiles=true`: recursively empty `UPLOAD_DIR` and
   `THUMBNAIL_DIR` (the directories themselves remain; the `tmp`
   subdirectory is recreated so follow-up uploads keep working).

Per-entry file errors are counted (`files.failures`) but do not abort the
purge – a single blocked handle should not prevent the rest of the
cleanup.

### What is preserved

- `users`, `roles`, `permissions`, `role_permissions`, `user_roles`
- WebAuthn credentials, password-reset tokens, sessions
- App configuration and secrets
- Backup snapshots on the ZFS dataset
- The `UPLOAD_DIR` and `THUMBNAIL_DIR` directories themselves (only their
  contents are cleared)

## Frontend UI

The purge is implemented as a dedicated **Danger Zone** section in
[`frontend/src/views/DataManagementView.vue`](../frontend/src/views/DataManagementView.vue):

1. The section is rendered only if the logged-in user has the
   `photos.purge` permission.
2. Clicking "Delete all photo data…" opens a modal dialog.
3. The dialog requires **two** confirmations:
   - Selection of the mode (`Database only` vs. `Database + files`).
   - Typing the keyword `LÖSCHEN` (case-insensitive, trimmed).
4. Only then does the confirmation button become active.
5. After the call, the dialog stays open and shows a table with the number
   of deleted rows per table, the file cleanup status, and the result of
   the embedding-service call.

## Security considerations

- **Double safety**: the permission is not in the Admin default, and a
  confirmation phrase is required. Both must be bypassed for a purge to
  happen accidentally.
- **Audit**: the endpoint runs as a regular Encore.ts API and is
  therefore visible in the standard traces (`encore run` dev dashboard
  at <http://localhost:9400/>).
- **Backups**: before a purge in production environments, the ZFS
  snapshot system described in
  [`DEPLOYMENT.md`](../DEPLOYMENT.md#automatic-daily-backup-recommended)
  should ensure that an application-consistent snapshot exists. In an
  emergency, the state can be fully restored via `zfs rollback`
  (variant A in DEPLOYMENT).
- **Embedding service outage**: if the `DELETE /photos` call to the
  Python service fails, the response is marked accordingly. The DB
  state is still consistent (empty); the orphaned embeddings can be
  removed later by calling again or by restarting the embedding
  container.

## Related endpoints

| Endpoint                       | Permission          | Scope                               |
|--------------------------------|---------------------|-------------------------------------|
| `DELETE /photos/:id`           | `photos.delete`     | Single photo                        |
| `DELETE /photos/:id/hard`      | `photos.delete`     | Single photo + file                 |
| `POST   /photos/purge`         | `photos.purge`      | **All photos of the installation**  |
