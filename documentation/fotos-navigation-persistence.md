# Photos Module – Navigation and Persistence

This document describes how the current state of the photo views
(gallery, album, persons, album list) is preserved across page changes,
what is persisted in the browser, and when that data is reset.

---

## Overview

The photos module consists of four main views that are closely
interlinked:

| Route | Name | Component |
|---|---|---|
| `/fotos/galerie` | `fotos-gallery` | `GalleryView.vue` |
| `/fotos/alben` | `fotos-albums` | `AlbumsView.vue` |
| `/fotos/alben/:id` | `fotos-album` | `AlbumDetailView.vue` |
| `/fotos/personen` | `fotos-persons` | `PersonsView.vue` |

The central link is the **`photoNav` Pinia store**
(`stores/photoNav.ts`), which connects all four views with each other
during the browser session.

---

## The `photoNav` Store

### State

```typescript
selectedPhotoId:  number | null   // last viewed photo
selectedAlbumId:  number | null   // album the photo came from
jumpIntoAlbum:    boolean         // one-shot jump flag (see below)
scrollPositions:  Record<string, number>  // scroll offset per view key
```

### Persistence

| Field | Lives in | Key | Survives refresh? |
|---|---|---|---|
| `selectedPhotoId` | Pinia only (RAM) | – | ✗ |
| `selectedAlbumId` | Pinia + localStorage | `albums_last_focused_album_id` | ✓ |
| `jumpIntoAlbum` | Pinia only (RAM) | – | ✗ |
| `scrollPositions` | Pinia only (RAM) | – | ✗ |

`selectedPhotoId` does not survive a refresh — on startup the gallery reads
the **separate** `localStorage` key `photos_last_selected_id` instead,
which `GalleryView` writes after every hydration (cursor movement).

`selectedAlbumId` and `albums_last_focused_album_id` are deliberately
identical to the key used by `rememberFocusedAlbumId()` / `readRememberedAlbumId()`
from `utils/albumsViewState.ts`. This way `AlbumsView` and the
store do not have to keep the same value twice.

### Methods

| Method | Called by | Effect |
|---|---|---|
| `selectPhoto(id)` | GalleryView, PersonsView | sets `selectedPhotoId`, clears `scrollPositions` |
| `selectPhotoInAlbum(photoId, albumId)` | AlbumDetailView | sets both IDs, writes `albumId` to localStorage, sets `jumpIntoAlbum = true` |
| `consumeAlbumJump()` | AlbumsView (onMounted) | returns the current value, sets the flag to `false` |
| `saveScrollPosition(key, px)` | (reserved) | stores the scroll offset for later use |
| `getScrollPosition(key)` | (reserved) | reads the stored offset |

---

## Persistence Layers at a Glance

### 1. `localStorage` (persistent across pages)

| Key | Value | Written by | Read by |
|---|---|---|---|
| `photos_last_selected_id` | last photo ID | `GalleryView.hydrateCursor()` | `GalleryView` (onMounted) |
| `albums_last_focused_album_id` | last album ID | `rememberFocusedAlbumId()`, `photoNav.selectPhotoInAlbum()` | `AlbumsView` (`readRememberedAlbumId()`), `photoNav` store (init) |
| `albums_last_photo_by_album` | map `albumId → photoId` | `AlbumDetailView.saveLastPhotoForAlbum()` | `AlbumDetailView.loadData()` |
| `albums_view_state` | filter/sort/search | `AlbumsView.saveAlbumsStateToStorage()` | `AlbumsView` (onMounted), `AlbumDetailView.navigateBackToAlbums()` |
| `albums_view_mode_by_album` | map `albumId → 'grid' \| 'map'` | `AlbumDetailView.saveViewModeForAlbum()` | `AlbumDetailView` (when loading a map-capable album) |
| `sharedAlbumViewMode:<token>` | `'grid' \| 'map'` per share token | `SharedAlbumView.persistViewMode()` | `SharedAlbumView` (on load, also for anonymous visitors) |

The last two remember, per (map-capable) album or per share link, whether the
user last chose grid or map; without a stored choice, a map-capable album
opens in map view.

### 2. Pinia (RAM, reset on refresh)

- `selectedPhotoId` — current photo ID in the session
- `selectedAlbumId` — filled from localStorage on init, always current afterwards
- `jumpIntoAlbum` — one-shot flag between AlbumDetailView and AlbumsView
- `scrollPositions` — not actively used (reserved)

### 3. URL query parameters (deep-linkable)

| Parameter | View | Behavior |
|---|---|---|
| `?photoId=<id>` | GalleryView | opens the photo directly in fullscreen view |
| `?photoId=<id>` | AlbumDetailView | In grid mode: selects the photo and scrolls to it. In map mode: expands the corresponding day in the timeline, highlights the cluster and scrolls the timeline to center on the stop. If the user then clicks the pin, the fullscreen view starts directly with *exactly this* photo (not the first photo of the cluster). The fullscreen list covers **the whole trip** in chronological order (all days/stops), so that paging and slideshow run through without a day boundary – see [`documentation/photo-slideshow.md`](./photo-slideshow.md). |
| `?q`, `?owner`, `?sortBy`, … | AlbumsView | restores filter/sort (for deep links and tab sync) |

URL parameters are removed immediately after being read via `router.replace()`,
to keep the URL clean.

---

## Navigation Flows

### Gallery → Gallery (same tab, different filters)

`VirtualGallery` reacts to changes in filter/sort/search with a
complete reload (`source.init()`). The `initialAnchor` prop (photo ID) only
takes effect on the first mount — afterwards only the new anchor `null` applies
(start of the window of the new query).

### Album → select photo → Gallery

1. `AlbumDetailView.watch(selectedPhoto)` calls `photoNav.selectPhotoInAlbum(photoId, albumId)`.
2. The store sets `selectedPhotoId`, `selectedAlbumId`, `jumpIntoAlbum = true` and writes `albumId` to localStorage.
3. The user navigates to the gallery via the main menu.
4. On mount, `GalleryView` reads: priority 1) `?photoId=` — not set; priority 2) `photoNav.selectedPhotoId` — set → `initialAnchor = photoId`.
5. `VirtualGallery` loads a window around the photo (`aroundPhotoId`), finds its exact index via `findLoadedIndexById()` and scrolls directly there.
6. `onGalleryLoaded` additionally sets `cursorIndex` and calls `hydrateCursor()`, so that the desktop sidebar shows the photo immediately.

### Gallery → Albums (first visit after album selection)

`AlbumsView.onMounted()` checks `photoNav.consumeAlbumJump()`:
- **true**: navigates immediately to `/fotos/alben/<albumId>` (no `loadData()`), calling `rememberFocusedAlbumId(albumId)` beforehand.
- **false**: normal `loadData()` path, the album is highlighted in the list.

Once in the album, `AlbumDetailView.loadData()` reads the photo ID from the
fallback chain:
1. `?photoId=` query parameter (not set)
2. `loadLastPhotoMap()[albumId]` (stored in localStorage)
3. `photoNav.selectedPhotoId` (in RAM)

The photo is selected and scrolled to.

### Gallery → Albums (further visit without a new album selection)

`jumpIntoAlbum` is `false` (it was consumed on the first visit).
`AlbumsView` loads the album list normally. `rememberedAlbumId` is known from
`readRememberedAlbumId()` (localStorage) or — as a fallback — from
`photoNav.selectedAlbumId` (RAM).
`VirtualAlbumGrid` scrolls to the album and highlights it.

### Album → back to the album list

`AlbumDetailView.navigateBackToAlbums()` calls `rememberFocusedAlbumId(albumId.value)`
(writes to localStorage) and navigates to `/fotos/alben` with the
restored filter/sort query params. `AlbumsView` reads
`rememberedAlbumId` from localStorage on mount and passes it on to
`VirtualAlbumGrid`.

### Persons → select photo → Gallery

`PersonsView` calls `photoNav.selectPhoto(photo.id)` (without album context).
The gallery uses `selectedPhotoId` as `initialAnchor` — identical
flow to the album-to-gallery path, just without `jumpIntoAlbum`.

---

## When Is What Reset?

| Event | What is reset |
|---|---|
| User selects a new photo | `scrollPositions` is cleared (all views scroll to the new selection) |
| `jumpIntoAlbum` is consumed | Flag is set to `false` (one-shot) |
| Browser refresh | `selectedPhotoId`, `jumpIntoAlbum`, `scrollPositions` are lost; `selectedAlbumId` remains (localStorage) |
| User clears localStorage | All persisted values gone; app starts without a preselection |
| Filter/sort changes | `VirtualGallery` reloads, scrolls to the start of the new results |

---

## Component Interplay (schematic)

```
AlbumDetailView
  watch(selectedPhoto)
    └─► photoNav.selectPhotoInAlbum(photoId, albumId)
          ├─ selectedPhotoId = photoId         (RAM)
          ├─ selectedAlbumId = albumId         (RAM + localStorage)
          └─ jumpIntoAlbum   = true            (RAM)

  saveLastPhotoForAlbum(albumId, photoId)
    └─► localStorage["albums_last_photo_by_album"][albumId] = photoId

GalleryView (onMounted)
  initialAnchor = photoNav.selectedPhotoId    (RAM)  ← after album selection
               ?? localStorage["photos_last_selected_id"]  ← after refresh
  VirtualGallery(:around-photo-id="initialAnchor")
    └─► loadAndScroll(anchor)
          ├─ source.init(aroundPhotoId)       ← load window from the server
          ├─ findLoadedIndexById(anchor)       ← look up exact index
          └─ virtualizer.scrollToIndex(row)   ← scroll there
  onGalleryLoaded()
    └─► hydrateCursor(idx) → photoNav.selectPhoto(id)
                           → localStorage["photos_last_selected_id"] = id

AlbumsView (onMounted)
  if photoNav.consumeAlbumJump() && selectedAlbumId
    ├─ rememberFocusedAlbumId(selectedAlbumId)
    └─► router.push("/fotos/alben/<albumId>")   ← straight into the album
  else
    ├─ loadData()
    └─ rememberedAlbumId = readRememberedAlbumId()   (localStorage)
                        ?? photoNav.selectedAlbumId  (RAM, fallback)
       └─► VirtualAlbumGrid(:rememberedAlbumId)      ← highlight album
```

---

## Affected Files

| File | Role |
|---|---|
| `frontend/src/stores/photoNav.ts` | Central store for photo/album selection |
| `frontend/src/utils/albumsViewState.ts` | localStorage helpers for album filter, sort and focused album |
| `frontend/src/views/GalleryView.vue` | Reads `initialAnchor`, writes `photos_last_selected_id` |
| `frontend/src/views/AlbumDetailView.vue` | Calls `selectPhotoInAlbum`, reads `loadLastPhotoMap` |
| `frontend/src/views/AlbumsView.vue` | Consumes `jumpIntoAlbum`, reads `rememberedAlbumId` |
| `frontend/src/views/PersonsView.vue` | Calls `selectPhoto` |
| `frontend/src/components/VirtualGallery.vue` | `loadAndScroll`: photo-exact scrolling via `findLoadedIndexById` |
| `frontend/src/composables/useGallerySource.ts` | `source.init(aroundPhotoId)`: backend window around the anchor photo |
