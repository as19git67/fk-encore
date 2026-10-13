# iOS Backup & Sync – Architecture

As of: June 2026

This document describes the **backup/sync architecture** of the native
iOS app (`ios/`): how photos are uploaded from the device to the server
(upload sync) and downloaded back to the device (download sync), how the
process runs in the background, and how duplicates are avoided. It
complements the feature inventory in [`ios-app.md`](./ios-app.md) with the
technical details.

---

## 1. Components

| File | Role |
|---|---|
| `Features/Sync/PhotoSyncService.swift` | Orchestrates an upload sync run (`actor`). |
| `Features/Sync/AssetUploadEnqueuer.swift` | Converts a `PHAsset` into an `UploadQueueItem` (shared by manual & automatic upload). |
| `Features/Sync/UploadQueue.swift` | Persistent upload queue in the app group container (`actor`). |
| `Features/Sync/PhotoHashing.swift` | Computes `imageDataHash` / `fullHash` (`PhotoHasher`). |
| `Features/Sync/BackgroundSyncManager.swift` | Background execution (BGTask / PhotoKit), queue drain, network gate. |
| `Features/Sync/PhotoDownloadService.swift` | Two-way sync: downloads server photos to the device (`actor`). |
| `Features/Sync/PhotoSyncPreferences.swift` | UserDefaults keys & typed accessors for the upload. |
| `Features/Sync/DownloadSyncPreferences.swift` | Same for the download. |
| `Features/Sync/SyncProgress.swift` | Observable progress for the UI. |
| `Features/Sync/SyncSettingsView.swift` / `DownloadSettingsView.swift` | Settings. |
| `Features/Sync/ServerAlbumPickerView.swift` | Device album → server album mapping. |
| `Core/Storage/SharedStorage.swift` | App group UserDefaults (token/server URL sharing with the share extension). |
| `F4milShare/` | Share extension for uploading from other apps (code). `App/ShareExtension/` contains only its `Info.plist`. |

App group: **`group.dev.fk-encore.F4milPhotos`** (shared container for the
queue file, temp files and shared UserDefaults).

---

## 2. Hashing & Dedup Model

`PhotoHasher` produces a `PhotoHashResult` with three values per asset:

- **`imageDataHash`** – SHA-256 of the **decoded image pixels**. Stable across
  caption/favorite/date changes → identifies "the same image".
- **`fullHash`** – SHA-256 over `imageDataHash + caption + isFavorite +
  capturedAtString`. Changes on **every sync-relevant** change →
  identifies "this image in exactly this state".
- **`capturedAtString`** – capture time in `TimeZone.current` (v2 cache;
  fixes UTC drift for downloaded photos).

Important: what is hashed and uploaded are the bytes of the **best resource**
(`AssetUploadEnqueuer.bestResource`) – preferably the **edited** render
(`.fullSizePhoto`), otherwise the original (`.photo`). The hash pipeline,
uploaded bytes (`PhotoSyncService.loadAssetData`) and background jobs must
use the same resource selection, so that server-side dedup works identically
across both upload paths (#591). The file name, by contrast, is read from the
`.photo` resource (the `.fullSizePhoto` render is generically named
`FullSizeRender.heic`).

`PhotoHasher` caches results per `localIdentifier` and skips
re-hashing as long as the asset's `modificationDate` is unchanged
(`PhotoSyncPreferences.HashCacheEntry`).

---

## 3. Upload Sync Pipeline (`PhotoSyncService.sync()`)

Preconditions (otherwise a silent abort): `syncEnabled`, network gate
satisfied (see §6), photo permission `.authorized`/`.limited`.

1. **Drain the queue first** (`drainQueueWithProgress`) – share extension items
   and leftovers of an aborted run are uploaded immediately, so that the
   user sees progress instead of waiting for the library scan.
2. **Determine assets** (`fetchAssets`, off-main): depending on the selection,
   the whole media library (sentinel `__all_photos__`) or the **confirmed**
   album IDs; filtered via `PHFetchOptions` (images only, `creationDate`/
   `modificationDate` newer than the album watermark, optionally screenshots
   excluded).
3. In **batches of 500**:
   - **Hash** (`PhotoHasher`, with cache).
   - **Sync check**: `APIClient.syncCheck` (`POST /photos/sync/check`) returns
     which `fullHash` values the server already has.
   - **Enqueue** the missing assets (and those not yet in the queue)
     as `UploadQueueItem` via `AssetUploadEnqueuer.makeQueueItem`, then
     another queue drain.
   - **Watermark** per source album advances monotonically to the newest
     `creationDate` of the successfully processed assets (`advanceAlbumSyncDate`
     only writes if strictly newer → no backward jumps on out-of-order
     completion). Assets whose hash failed (e.g. iCloud bytes unavailable) are
     **deliberately not** included in the watermark and are retried on the next
     run.
4. **Completion**: final drain + set `lastSyncDate`.

On every exit path (including task cancellation through the BGTask time limit)
the progress is reset, so the spinner never gets stuck.

### Manual Upload

`PhotoUploadView` uses the same `AssetUploadEnqueuer`, so that manually and
automatically uploaded photos are deduplicated identically on the server.

---

## 4. Upload Queue (`UploadQueue`)

- **Persistence**: JSON file `upload_queue.json` in the app group container →
  survives app restarts and is readable by the main app **and** the share
  extension. Temporary image data is stored in `pending_uploads/`.
- **Status** per item: `pending → uploading → done | failed`.
- **Concurrency**: `claimNextPending()` **atomically** switches an item from
  `pending` to `uploading`. From then on it is invisible to other drain runs
  (other process: main app vs. share extension) – prevents the
  double uploads that used to create server duplicates.
- **Resumption**: uploads aborted by background suspension
  end up as `failed` with a transient error message; `requeueTransientFailures()`
  (on foreground resume) resets these to `pending`. `resetStaleUploading()`
  at app start cleans up `uploading` items left hanging after a crash.
- **UI**: `UploadQueueObserver` (`@Observable @MainActor`) mirrors the queue
  live into SwiftUI via an `AsyncStream`.

---

## 5. `UploadQueueItem` & Server Contract

An `UploadQueueItem` carries, among others, `imageDataHash`, `fullHash`,
`capturedAtString`, `caption`, `isFavorite`, `targetAlbumIds`,
`sourceIosAlbumId`, optional GPS coordinates and (for share extension items)
a `tempFileURL`.

The upload request to **`POST /photos`** (`photo/photo.ts`) carries the
metadata as headers:

| Header | Content |
|---|---|
| `X-File-Name` | Original file name (percent-encoded) |
| `X-Image-Data-Hash` | Pixel hash → server-side dedup |
| `X-Full-Hash` | State hash |
| `X-Description` | Caption (percent-encoded) |
| `X-Is-Favorite` | `true`/`false` |
| `X-Captured-At` | Capture time |
| `X-Asset-Id` | `PHAsset.localIdentifier` → dedup/replace via `device_asset_id` |
| `X-GPS-Lat` / `X-GPS-Lon` | GPS fallback (the resource bytes are EXIF-stripped) |

Further endpoints:
- **`POST /photos/sync/check`** – batch comparison: which `fullHash` values already exist.
- **`POST /photos/sync/metadata`** – metadata-only sync (pixels unchanged,
  only caption/favorite/date changed); `.notFound` ⇒ fallback to a full upload.
- **`GET /photos/index`** (ETag) – fast skip for the download (§7).

---

## 6. Network Gate ("Nur WLAN" / Wi-Fi only)

`BackgroundSyncManager.networkAllowsUpload()` is the **single** source of
truth for the gate and is evaluated freshly both before and **during** the
queue drain (before each item):

- `PhotoSyncPreferences.wifiOnly` (default **on**) directly from UserDefaults.
- Live path of `PhotoSyncService` (`isWifiConnected` / `isNetworkAvailable`).

This way, toggling the setting or a connectivity change takes effect
immediately, even in the middle of a drain (an item running when "Nur WLAN"
is switched back on is put back as `pending`).

> **First-path race (fixed):** `NWPathMonitor.currentPath` is not yet reliably
> populated in the short window right after `start()`. Previously, the
> **first** tap on "Jetzt synchronisieren" (sync now) therefore wrongly
> reported "no Wi-Fi" and you had to tap twice. `PhotoSyncService`/
> `PhotoDownloadService` now cache the path via the `pathUpdateHandler` and
> **on the first call wait for the first update** (with a safety timeout)
> before they answer.

---

## 7. Overall Pipeline & Triggers

All triggers go through **`BackgroundSyncManager.runFullSync()`**: trip auto-add
→ **download/bisync sync** (`PhotoDownloadService.sync()`) → queue drain →
upload sync (`PhotoSyncService.sync()`). `runFullSync()` is protected by
`pipelineLock` against a second simultaneous run (manual tap +
foreground resume + BG task), so two pipelines never overlap.

> **Order download before upload (important):** A photo **deleted** on the
> server must first be removed from the local album via the download (moved
> to "F4mil Trash") **before** the upload scan runs. Otherwise the upload
> sees the still-existing local copy in the album, uploads it again and lets
> the deleted photo **resurrect** (it shows up in the album again while a
> stray copy sits in the trash). Download-first closes this race for every
> downloaded photo — independent of the round-trip tracking set.

> **Important:** The download half used to run **exclusively** in the
> BGProcessingTask. Since iOS runs this task only rarely and mostly during
> charging/idle, a **manually** triggered sync never downloaded photos that
> had been added to the album on the server. Since all triggers go through
> `runFullSync()`, the download also runs on a manual tap and on foreground
> resume.

Triggers:

- **Manual tap** ("Jetzt synchronisieren", `SyncSettingsView`) → after the
  network pre-check, `runFullSync()`.
- **Foreground resume** (`applicationWillEnterForeground`, app was suspended,
  not terminated) → `handleForegroundResume()` → `requeueTransientFailures()` +
  `runFullSync()`.
- **Cold start** (`MainTabView.task` in `ContentView.swift`) → likewise
  `handleForegroundResume()`. `applicationWillEnterForeground` fires **only**
  when waking from suspend, not on a fresh process start. If the app was
  terminated by the system in the background (jetsam — see the box below, very
  likely without a charging cable), the next open is a cold start;
  without this second trigger, an interrupted sync would stay put until the
  next manual tap. `pipelineLock` makes double triggers (e.g. both
  triggers shortly after one another) a no-op.
- **BGProcessingTask** (see below) → `runFullSync()`.

> **Aborted manual sync — why it used to always restart at 0:**
> On a manual tap, `runFullSync()` runs as a plain `Task` **without**
> background execution time from the system. Without a charging cable/idle, iOS
> freezes the app almost immediately after backgrounding and can terminate it
> at any time (jetsam) to free memory — for "reopen the app without a
> background task having run in between" this is the normal case, not the
> exception. Two countermeasures:
> 1. `runFullSync()` requests real additional runtime via
>    `UIApplication.beginBackgroundTask`; its expiration handler cancels the
>    inner `Task` cooperatively (`Task.checkCancellation()`) instead of
>    letting the process freeze in the middle of a step.
> 2. The upload sync (`PhotoSyncService.sync()`) used to advance the
>    watermark per album only after a complete batch of 500. At
>    ~30 s hash time per 100 photos, a batch of 500 takes several minutes —
>    much longer than the app realistically gets as remaining runtime. As a
>    result, the watermark never moved, and every attempt visibly scanned from
>    the start again. `processingBatchSize` is now **50**, so that a batch
>    checkpoint is reachable even with a short remaining runtime.

Background execution, two paths depending on the iOS version:

- **iOS 26.1+**: PhotoKit background upload
  (`PHBackgroundResourceUploadExtension`). `enqueueForBackgroundUpload` bakes
  the `POST /photos` request including a freshly renewed token
  (`APIClient.ensureFreshToken()`) and hands it to the system. Note: since there
  is (not yet) a dedicated extension target, the system job cannot renew the
  token itself – if it runs after expiry, it fails silently and the
  foreground drain uploads again later.
- **iOS < 26.1 / fallback**: `BGProcessingTask`
  (`dev.fk-encore.F4milPhotos.photoSync`). `register()` is registered in the
  `AppDelegate` before the end of app launch; `scheduleNextSyncIfNeeded()` schedules the
  next run on moving to the background (`requiresNetworkConnectivity = true`,
  `earliestBeginDate` +5 min) and cancels it if neither upload nor download is
  active. The handler calls `runFullSync()`.

`drainUploadQueue()` is protected by `drainLock` against a second simultaneous
drain in the same process; across processes, the atomic
`claimNextPending()` step additionally protects.

---

## 8. Album Mapping & Selection

- **Configuration** happens through two mirror-image entry points that write
  the **same** link — everything behind it (upload scan,
  deletion reconciliation, bisync download) does not know the difference:
  1. **iOS media library → "Verfügbar machen"** (make available)
     (`LibraryBrowserViewModel.makeAvailable`): starts at the iOS album,
     finds/creates the server album.
  2. **f4mil album → "Mit iPhone synchronisieren…"** (sync with iPhone)
     (`AlbumSyncLinkModel.link`, issue #812): starts at the **server album**
     and finds/creates the iOS album via
     `IOSAlbumLocator.findOrCreate(named:)`. This is the way for **shared
     albums**: anyone with edit permission on someone else's album can
     contribute their own photos there without first having to rename a local
     album to match. Reachable from the context menu of the album list and
     the overflow menu of the album detail view; requires write access, because
     all three modes upload.
     Preconditions (`AlbumSyncLinkModel.precondition`, pure & tested):
     write access, non-empty name, server album not yet linked, and
     no iOS album of the same name that is already attached to a **different**
     server album (otherwise two links would fight over the same iOS album).
  The settings
  (`SyncSettingsView` → "Foto-Synchronisierung" / photo synchronization) now
  contain only the main switch, global options (Wi-Fi only, screenshots),
  status and the manual trigger — no album selection/mapping anymore. Only
  regular user albums can be linked; smart albums are not shown.
  **Empty albums are listed too** (issue #822), so that a
  synchronization can be set up before the first photo; the
  prompt "alle Fotos / nur neue" (all photos / only new) remains relevant,
  because it sets the watermark (`creationDate`) and thereby decides about
  older photos added later.
- **Name matching is trimmed** (issue #849): iOS keeps trailing whitespace in
  a name, the web trims on creation. `AlbumName.normalized/matches`
  compares both sides trimmed and sends the trimmed name to the
  server (which additionally trims it in `createAlbumLogic`/`updateAlbumLogic`),
  so that "Urlaub " (vacation) no longer creates a second album next to "Urlaub".
- **One-time migration `purgeLegacySmartAlbumsIfNeeded()`** (in
  `PhotoSyncService.sync()`, before the deletion reconciliation): legacy configurations
  that referenced a smart album (favorites, recents, …) via the former settings picker
  are neither visible nor unlinkable and dynamically unsafe.
  The migration classifies the stored IDs via PhotoKit
  (`assetCollectionType == .smartAlbum`) and removes smart album entries from
  all sync config stores (`purgeAlbumsFromConfig`). Photos already uploaded
  to the server remain untouched. The `__all_photos__` sentinel is kept
  (not a smart album, a legitimate whole-library choice).
- **Device album → server album**: `PhotoSyncPreferences.albumMappings`
  (`[iOS-localIdentifier: serverAlbumId]`), set on "Verfügbar machen"
  (name matching own → shared → create new).
- **Confirmed mappings**: `confirmedMappingIds` – only albums with an
  explicit user decision are auto-synchronized; unconfirmed ones
  are skipped.
- **"Gesamte Mediathek"** (entire media library): sentinel `__all_photos__` –
  enumerates all image assets directly; when the sentinel is set, individual
  albums are ignored (no accidental double sync).
- **Exclude screenshots**: `excludeScreenshots` (default **on**).
- **Server photo map**: `serverPhotoMap` (`[serverPhotoId: iOS-localIdentifier]`)
  is maintained on upload and used by the download to avoid downloading
  photos that already exist locally again. Is retained on
  `resetUploadHistory()` (structural knowledge).
- **Sync mode per album** (`albumSyncModes`, issue #812): `copy`, `sync` or
  `bisync`, chosen on "Verfügbar machen" in the iOS media library. Default
  `copy` (stage 2 behavior). For `sync`/`bisync`, the deletion reconciliation
  `PhotoSyncService.syncAlbumDeletions()` runs before the upload scan:
  current iOS album membership (`localIdentifier` only) vs.
  `GET /albums/:id/photos`; server photos that originate from this device via
  `serverPhotoMap` and whose source asset has left the iOS album
  are removed from the album via `POST /albums/photos/batch` (`action: "remove"`).
  **Non-destructive**: only the album assignment is
  removed, the photo stays on the server; web uploads (not in
  `serverPhotoMap`) are never touched; an unresolvable album is
  skipped (no accidental emptying).
- **Bisync** (stage 4): `bisync` = `sync` in the upload direction **plus** the
  download half for the same album pair. `PhotoSyncPreferences.bisyncServerAlbumIds()`
  returns the server album IDs of the bisync albums; `PhotoDownloadService` includes
  them in the download run — **even if "Automatisch herunterladen"
  (download automatically) is off**. So that removal on the iOS side does not
  needlessly end up in `F4mil Trash`, the delete-up pass calls
  `DownloadSyncPreferences.forgetDownloadedPhotos()`, so that the download side
  does not interpret these photos as "deleted on the server". **Additional
  delete-up gate for bisync**: A server photo is only removed if it is also
  registered in the download tracking of the album pair
  (`downloadedPhotos[serverAlbumId]`). The global `serverPhotoMap` alone is
  not enough — a photo uploaded from this device (e.g. via "Gesamte Mediathek")
  that was added to the album on the server was never in the iOS album; its
  absence there is not a local deletion, but a server addition that has not yet
  been synced down. The iOS target album is the same as for the upload (the
  download uses `getOrCreateIOSAlbum(named:)`, name equality through
  "Verfügbar machen").
- **Revoked shares** (`revokedLinkIds`, issue #812): A link can
  point to someone **else's** album. If the share is revoked, downgraded to
  read-only or the album deleted, the upload would otherwise fail
  with 403/404 again on every run. `PhotoSyncService.reconcileLinkAccess()`
  therefore fetches **one** `GET /albums` at the start of each run and parks all
  links whose target is not (or no longer) writable
  (`PhotoSyncPreferences.computeRevokedLinks`, pure & tested). Parked
  links are skipped by the upload scan (`fetchAssetsSync`), by the deletion
  reconciliation and by `bisyncServerAlbumIds()`; the media library shows the
  badge "kein Zugriff" (no access) along with an explanation. The set is
  **recomputed every time**, so a link reactivates itself as soon as access
  is back. A failed request deliberately leaves the stored set
  unchanged — a network error must never pass as a share revocation.
- **One-time copy of individual photos** (`LibraryPhotoCopyModel`, issue #812
  stage 5): "Nach f4mil kopieren…" (copy to f4mil) in the context menu of the
  media library grid and in the fullscreen view. Deliberately **no** permanent
  relationship — nothing is written to the link stores, and the queue item
  carries **no** `sourceIosAlbumId`, so that the one-time copy does not advance
  an album watermark and thereby swallow photos from the album's real sync.
  Target selection: all albums with write access (read-only shares would be
  rejected server-side). Copying multiple times is harmless: the server
  deduplicates via `full_hash` and only attaches the existing photo to the album.

---

## 9. Download Sync (Two-Way)

`PhotoDownloadService.sync()` downloads server albums to the device. There is **no
standalone download UI anymore** — the download only runs as a half of the
bisync mode. The `DownloadSyncPreferences` (including `downloadEnabled`, filters)
are retained internally; `downloadEnabled` is off by default and is no
longer toggled via the UI.

- Preconditions: `downloadEnabled` **or** at least one bisync album
  (`bisyncServerAlbumIds()`), network gate (own `wifiOnly` switch),
  album set = `selectedServerAlbumIds ∪ bisyncServerAlbumIds` not empty,
  photo permission `readWrite` (`.authorized`/`.limited`).
- **Fast skip via ETag**: `GET /photos/index` with `If-None-Match`. A **304**
  means "nothing changed" and skips the album walk. The first run
  (without an ETag) does the full walk and stores the ETag. The server-side
  fingerprint (`getPhotoIndexFingerprint`) includes, besides the own photos,
  also the **album memberships** (MAX `added_at` + COUNT over
  `album_photos`) and the photo `updated_at` of the members in all visible
  albums (own + shared) — otherwise adding an existing photo to an album
  (just an `album_photos` insert) would not change the ETag
  and the 304 fast skip would hide server-side album changes.
- Own `F4mil Trash` mechanism for moving deleted photos (only with
  `readWrite` access).
- Own `NWPathMonitor` with the same first-path-await logic as the upload.

Settings in `DownloadSyncPreferences` (`download.enabled`,
`download.wifiOnly`, selected server albums, `lastIndexETag` …).

---

## 10. Share Extension & Token Sharing

- The share extension puts photos to be uploaded as `UploadQueueItem`
  (with `tempFileURL`) into the same `UploadQueue` → the main app uploads them
  on the next drain.
- **`SharedStorage`** (app group UserDefaults) mirrors access/refresh token,
  token expiry (`tokenExpiryKey`, epoch seconds) and server URL, so that the
  extension makes API calls without access to the main app's keychain and can
  renew the token itself. `AuthManager.saveTokens`/`restoreSession` keep
  this mirroring up to date.
- The extension's `ShareHasher.imageDataHash` must remain **byte-identical** to
  the main app's `PhotoHasher.imageDataHash` so that dedup works.

---

## 11. Error Handling & Retry

- Transient `URLError`/cancellation errors are classified
  (`isTransientErrorMessage`) and automatically put back into the queue.
- Items whose asset bytes cannot be hashed (iCloud unavailable) are
  skipped and retried on the next run (no watermark advance).
- `retryCount`/`lastError` per item; the UI offers "Alle erneut" (retry all) /
  "Alle löschen" (delete all).

---

## 12. Known Limits / Open

- No dedicated `PHBackgroundResourceUploadExtension` target → system upload
  cannot renew the access token itself (see §7).
- No "free up storage" (remove already backed-up originals from the device) –
  planned, see [`ios-app.md`](./ios-app.md) §5 / issue tracker.
- Purely photo-based; Live Photos / video are (not yet) backed up.
