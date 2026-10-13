# iOS App (FKPhotos) – Feature Inventory, Web Comparison & Parity Plan

As of: August 2026

This document describes the actual feature set of the native iOS app
(`ios/`, SwiftUI), compares the **photo area** of the web app with the iOS
app, and derives a prioritized plan to reach feature parity – **where it makes
sense**. It also proposes iOS-specific extensions that only make sense on the
device.

> **Important note on documentation:** `FEATURE_COMPARISON.md` described the
> iOS app for a long time as "read-only, no auto-backup". That is
> **outdated**. The app now has a complete background backup stack, two-way
> sync, a share extension, passkeys, and comments/reactions. This document
> catches up on the missing documentation.

---

## 1. Architecture Overview

- **Language/UI:** Swift / SwiftUI, `@Observable` view models.
- **Entry point:** `App/ContentView.swift` → `MainTabView` with five tabs:
  **Feed**, **Alben** (albums), **Trip**, **Suche** (search), **Einstellungen**
  (settings). People hang off the album list; **Rückblicke** (look-backs) and
  **Gruppen-Review** (group review) hang off the feed toolbar.
- **Network:** `Core/Networking/APIClient.swift` (+ `AuthInterceptor`),
  talks to the same Encore.ts API as the web frontend.
- **Auth:** `Core/Auth/` – `AuthManager`, `KeychainHelper`, `PasskeyManager`.
- **Storage/cache:** `Core/Storage/` – `ImageCache`, `ThumbnailLoader`,
  `SharedStorage` (shared with the share extension).
- **App targets:** main app, **share extension** (code in `F4milShare/`, its
  `Info.plist` in `App/ShareExtension/`) for uploading from other apps.
- **Language:** The app is German throughout — and tells the system so:
  `CFBundleDevelopmentRegion = de` in both Info.plists (app and share
  extension) as well as `developmentRegion`/`knownRegions` in the Xcode
  project. Without this setting the bundle reports English as its only
  language, and iOS then draws its own UI — cut/copy/paste, keyboard,
  standard buttons, photo picker, share sheet — in English, in the middle of
  German texts. Custom strings are still hard-coded; real multilingual support
  would additionally require a string catalog.
- **No XML comments in `Info.plist` and `.entitlements`.** Xcode writes
  property lists back in its canonical form when the target is opened — keys
  sorted alphabetically, comments removed. If the file in the repo deviates
  from that, a diff shows up in the working tree after every build, which has
  to be reverted before the next `git pull` (this happened from #1252 on, when
  the first comment was added). What a key means is therefore documented here
  or in `ios/App/ShareExtension/README.md`:
  `PHPhotoLibraryPreventAutomaticLimitedAccessAlert` in 2.13,
  `CFBundleSpokenName`/`INAlternativeAppNames` in 2.14, the
  `applinks:` entitlement in 2.11.
- **Build number:** `CURRENT_PROJECT_VERSION` is no longer maintained by hand
  (it fell sixteen pull requests behind that way), but derived from the commit
  count by the pre-commit hook:
  `scripts/sync-ios-build-number.sh` sets it on every commit that touches
  `ios/` to `git rev-list --count HEAD + 1` — in all four build
  configurations together, because the app and the share extension must carry
  the same `CFBundleVersion`. The number never decreases, and in a shallow
  checkout (CI, `--depth`) nothing happens, because the count there would be
  smaller than the history it comes from. `MARKETING_VERSION` remains a
  deliberate manual decision.

### 1.1 The share extension's session

The extension cannot reach the app's keychain. The app therefore mirrors
access and refresh tokens, including their expiry time, into the app group
(`SharedStorage`), and the extension reads them from there — via `ShareAuth`,
which can do both: **refresh beforehand** when the stored expiry is
approaching, and **refresh once on 401** and retry the request. An access
token lives 15 minutes, a refresh token 30 days; without refreshing, the
extension was therefore "not set up" a quarter of an hour after the last app
launch.

Two rules that have to work together here:

- **The extension writes the rotated pair back into the app group**,
  including the expiry time. Only that way does the app see that the session
  has moved on.
- **The app does not overwrite an existing session in the group**
  (`SharedSession.shouldMirror`). It fills it if there is none. The
  extension's rotation never reaches the keychain — it cannot write to it —,
  and mirroring at launch would have replaced the freshly rotated session
  with the old one. After the five minutes of grace the server allows a
  rotated refresh token, the only remedy was to sign in again.

---

## 2. Implemented iOS Features (Documentation Catch-up)

The following features exist in the code but were so far **not
documented**:

### 2.1 Authentication
- Password login (`AuthViewModel`, `LoginView`, `RegisterView`).
- **Passkeys / WebAuthn** (`PasskeyManager`, via `ASAuthorization`):
  registration + login against `/passkeys/register/*` and `/passkeys/auth/*`.
- Token persistence in the keychain (`KeychainHelper`).

### 2.2 Photos & Gallery
- **"Alle Fotos" (all photos) timeline** (`PhotoTimelineView` → `PhotoYearView` →
  `PhotoMonthGridView`) via `/photos/timeline`, as a virtual album at the top
  of the album list.
- **Fullscreen viewer** (`PhotoFullscreenView`, ~740 lines): native pinch zoom
  (`ZoomableImageView`), swipe navigation, metadata overlay.
- **Filter & sorting** (`FilterSortViewModel`, `FilterSortMenuView`):
  favorite, GPS present, date range; sorting by date etc.
- **Multi-select in "Alle Fotos"** (issue #767, stage 2): in the filtered flat
  view of `PhotoTimelineView` via long press or toolbar button, including
  drag-select and the batch actions "add to album" and "share" — the same as
  in the album and in the month grid. The state lives in the shared
  `PhotoSelection` (`PhotoSelectionShare.swift`). Only available in the
  filtered view: unfiltered, the timeline shows year tiles, not photos. A
  filter change discards the selection so that no invisible photos end up in a
  batch action.
- **Selecting by swiping** (all photo grids, `DragToSelect` in
  `PhotoSelectionShare.swift`), as in Apple Photos: a swipe that begins
  **sideways** selects and may then continue in any direction; one that begins
  upward or downward scrolls. While selecting, the grid stays put, the
  navigation's back swipe gesture waits, and near the top or bottom edge the
  grid keeps scrolling by itself (faster the closer the finger is to the
  edge). If the swipe begins on an already selected photo, it deselects
  instead of selecting — likewise as in Photos; the direction applies to the
  whole swipe, wiggling back flips nothing. Apple documents no API for this
  one-finger gesture — UIKit's built-in multi-select is a two-finger swipe on
  a `UICollectionView`, while the grids here are SwiftUI —, so it is rebuilt
  as a `UIPanGestureRecognizer` that makes the scroll view and the back
  gesture wait for it via `shouldBeRequiredToFailBy`.
- **Metadata view** (`PhotoMetadataView`): file info, capture date,
  description, quality rating ("x von 4", i.e. x of 4), recognized people.
- **Per-photo map**: MapKit mini map with a marker when GPS is present.
- **Auto-crop focus point** is taken into account in the thumbnail
  (`PhotoThumbnailView(autoCrop:)`).

### 2.3 Photo Actions
- Toggle **favorite** (heart) in fullscreen.
- **Change capture date**.
- **Add to album** (`AddToAlbumManager`, picker).
- **Share** via the native iOS share sheet (`PhotoShareManager`,
  `ActivityView`).
- **Name / merge people** directly from recognized faces
  in fullscreen.
- **Hide / unhide**, **Remove from album** (in album context),
  **Delete** (only with `photos.delete`, with confirmation) and **Save original
  to the Photos library** – all in the fullscreen overflow menu (issue #762).

### 2.3a One Fullscreen Viewer, Not One per Context

- `PhotoFullscreenView` is **the** view for a single server photo:
  paging, zoom, heart/info/slideshow, hide, delete, download,
  "Zuschnitt…" (crop…), remove from album, location map, faces. Reachable from
  album, grid, timeline, people view, map, feed — and since #1085
  also from the search results and the review preview.
- Previously, a new single-image view was invented for each context. The
  search result had its own scroll page without paging and without zoom,
  whose curation buttons called a route that does not exist
  (`PUT /photos/curation` instead of `PATCH /photos/:id/curation`), whose
  errors were rendered nowhere, and in which "visible" appeared as a **green
  thumbs-down** next to a second thumbs-down. All three defects existed only
  because the page was written separately and never kept in sync afterwards;
  with the page they are gone (#1085 §3).
- What a context additionally needs is **passed in** rather than rebuilt:
  `albumContext` shows "remove from album" only where an album is being
  viewed, and `contextFooter` attaches a bar below the photo. The review
  preview is thus reduced to just this footer ("Nur dieses Foto behalten",
  i.e. keep only this photo, the keep toggles, AI pick, rating, peer votes) —
  pager, zoom and everything else are the viewer's.
- **Deliberate exception:** `LibraryPhotoFullscreenView` shows **device**
  photos (`PHAsset`). The canonical viewer is built on `PhotoWithCuration` and
  `/photos/file/…`; generalizing it over its image source would be a decision
  of its own.

### 2.4 Albums
- List with search, **pinning** (`AlbumPinPreferences`), swipe actions,
  create/delete.
- Detail view with grid, filter/sort, **multi-select incl.
  drag-select**, batch actions (add to album, share), upload.
- **View modes + consensus** (`AlbumViewMode`, issue #760): switcher for
  "Alle Fotos", "Meine Favoriten" (my favorites), "Gruppen-Highlights"
  (consensus), "Von anderen favorisiert" (favorited by others) and an "Eigene
  Ansicht" (custom view) with adjustable thresholds. The count-based modes
  only appear for shared albums. The chosen mode is remembered per album.
- **Album cover** (`AlbumCover`): "Als Albumcover festlegen" (set as album
  cover) in the grid's context menu, for everyone with write permission.
  Without a cover set, the album shows its newest photo — which moves on with
  every upload, which is why "Cover entfernen" (remove cover) is a decision of
  its own and an entry of its own.
- **Only the cover goes over the wire.** `PATCH /albums` treats a missing
  field as "unchanged", so a cover change does not overwrite a name or
  description that someone else has changed in the meantime. Conversely, this
  means removal has to send an explicit `null` — Swift would otherwise omit a
  `nil` when encoding, and the removal would silently do nothing.
- The server accepts only photos **from the album** as the cover; the same
  rule decides here what the menu offers in the first place.
- **Anonymized voting**: In shared albums, every thumbnail shows
  "3/5" badges for favorites and hides, and the fullscreen view an
  "Meinungen" (opinions) block with share bars. One's own favorite vote can be
  set directly from the grid context menu; the counters update immediately
  and are rolled back on error.

  Filtering happens **on the device**, not via the server-side
  `active_view`: The web resets this setting to `"all"` on every album load
  and filters client-side itself, so a preset stored by iOS would be silently
  discarded. Details in `documentation/album-photo-views.md`.
- **Album settings** (`AlbumSettingsView`) as on the web: change name,
  description and "Karte aktivieren" (enable map) (`display_mode`). Reachable
  via the detail view's overflow menu and the album list's context menu;
  sharing and deleting are possible from the same sheet. Anyone with write
  access may edit, only the owner may delete.
- **Share album** as on the web (`AlbumShareView`, `AlbumShareViewModel`,
  issue #918): invite internal users with "Nur lesen" (read only), "Bearbeiten"
  (edit) or "Bearbeiten + Teilen" (edit + share) (the latter only as owner),
  as well as a public link with expiry date, copy and share sheet. The shared
  link points to the SPA route `/app/albums/shared/<token>`
  (`AlbumPublicLinkURL`) — the same URL that `web/static.ts` builds
  server-side as the canonical `pageUrl` and enriches with Open Graph tags so
  that iMessage previews show the album name and cover. Not to be confused
  with `/albums/public/<token>`, the JSON API endpoint. The
  invitable users come from `/albums/:id/shareable-users`, so that non-admins
  and `write_share` delegates can share too; delegates can only remove their
  own invitations again. Reachable from the album detail view and directly
  from the running trip.
- **The iPhone library stands apart** (#1115 §5). It used to be the fourth row
  in the first section, on a par with "Alle Fotos", "Personen" and
  "Gruppen-Review" — as if it were another place *within* f4mil. Behind it,
  however, lies nothing from f4mil, but the device's photo library.
  Now: its own section "Vom iPhone" (from the iPhone) **directly after the
  f4mil places**, whose footer spells out the difference, and **modal** instead
  of pushed — a sheet with its own "Fertig" (done) is the platform's gesture
  for "a detour, you will come back", whereas a push would mean "deeper into
  the same material". The destination screen is called "iPhone-Mediathek"
  (not "iOS") and says at the top itself whose albums it shows. The section
  was first placed at the *end* of the list — which hid it: below a real album
  collection it is a long scroll away, and in the two empty states it was not
  rendered at all, so that precisely those who have no album yet had no way
  there.

### 2.5 People & Faces
- People grid (`PersonsListView`), rename, merge,
  ignore faces ("Alle ignorieren", i.e. ignore all).
- **Year tiles** in the person detail view (new, issue #391): a person's
  photos are grouped by year; with many photos, initially only
  the newest year is rendered.

### 2.6 Search
- **System search field** (`.searchable`): magnifier in the field, clear
  cross and "Abbrechen" (cancel) come from iOS instead of being rebuilt by
  hand. The field stays put while scrolling
  (`.navigationBarDrawer(displayMode: .always)`) —
  in a tab that exists only for searching, a search field that scrolls away
  would be a search you first have to find again. Searching happens on submit,
  not on every keystroke — every
  request is a round trip through the embedding service, and spending that on
  half-typed words would be wasteful. If the field is cleared (via × or
  "Abbrechen"), the hits disappear with it; otherwise the grid would be full of
  results for a query that is no longer on screen.
- Below the field there is **nothing** before a search. The earlier example
  queries sat where results appear and read as such.
- Natural-language search (`SearchView`, `SearchViewModel`) via the same
  endpoint as the web (`POST /photos/search/natural`): place and time range
  are parsed out of the query and applied as **filters** instead of being
  searched as words. "Kirchen in München von 2004 bis 2017" (churches in
  Munich from 2004 to 2017) thus means the same on both clients.
- **"Verstanden als:" (understood as) chips** (`NaturalSearch`,
  `SearchParseChips`) show the server's reading — semantic remainder, place,
  time range. Same rules as `useNaturalSearch` on the web: whole years
  collapse to "2004–2017", and the semantic chip appears only if something was
  actually extracted from the query.
- The endpoint returns only scored IDs; the rows are fetched afterwards via the
  batch endpoint `GET /photos/details` and put back into
  ranking order (`PhotoFetch.byIds`).
- A tap on a hit opens **the same fullscreen viewer as everywhere
  else**, paged across the whole hit list (#1085 §3/§4) — see 2.3a.
- Place/POI/radius additionally via `searchByLocation` (`/photos/search/location`).

### 2.6a Map over a Photo Collection

- **Map view** (`PhotoMapView`, MapKit) over the photos of an album,
  reachable from the overflow menu of the album detail view ("Karte").
  Below it the **timeline** as on the web: an "Übersicht" (overview) entry,
  followed by every stop across all days as one continuous chronological
  series. The first stop of a day carries the day color
  (`PhotoStops.dayColors`, identical to the web), so that the day boundaries
  stay readable in a long series.
- One selection, two views: "Übersicht" shows one pin per region
  (overview cluster across all days) plus dashed lines for the
  largest jumps. Selecting a stop shows **its day**, so that the neighboring
  stops stay visible, centers the map on it and highlights pin and
  card. Map and timeline follow each other.
- The pin carries the cover image; tapping opens its photos in the
  fullscreen viewer. A tap on a timeline card only selects — so
  scrolling never tears open the viewer.
- The grouping rules live in `PhotoStops.swift` — a port of
  `frontend/src/composables/usePhotoStops.ts` with the same constants, so that
  web and iOS draw the same pins for the same album: grouping by
  **local** day, two clustering passes per day (greedy by nearest
  centroid within the include radius, then merging all pairs
  below the separation radius), radii scaled to the extent of the
  day, overview clusters across all days, and the longest ~10 % of
  jumps between consecutive stops as dashed lines.
- **Zoom drives the clustering** (as on the web): what a stop is is whatever
  fits under one pin at the current zoom level. Zooming in splits
  stops, zooming out merges them — the timeline follows exactly,
  because pins and cards read the same clustering pass. The radius is
  projected from the visible region (`PhotoStops.clusterRadius`) and
  recomputed only when the gesture comes to rest and the radius changes by more
  than 2 % — a pure pan therefore costs no pass.
- **The selection is a photo, not a stop.** Re-clustering reassigns all
  stop IDs; an ID held across the zoom would afterwards point to something
  else. The selection is therefore tied to a photo ID, and the stop is
  re-resolved from it (`PhotoStops.stop(containing:in:)`) — as on the web via
  `selectedAnchorPhotoId`.

### 2.6b Non-destructive Editing (Crop/Tone)

- **Crop view** (`PhotoTransformsView`), reachable via "Zuschnitt…"
  in the overflow menu of the fullscreen viewer. The backend stack already
  existed in full (`photo/photo-transforms-crud.service.ts`,
  `documentation/photos-ai-transforms.md`) — only the client was missing.
- A "recipe" (crop, rotation, exposure, contrast, gamma, black/white
  point) applies **per user and per photo**; the original file is never
  modified. Three sources: one's own, that of other household members (can be
  adopted with a click) and the AI suggestion.
- Implemented (#1019 stage A): view and apply the suggestion per aspect ratio,
  adopt someone else's version, reset to the original. Rules
  and wire format in `PhotoTransforms.swift`.
- **Suggestions are never applied automatically** — and an AI suggestion
  exists only for aspect ratios for which a face was found as the image
  center; without a recognized face the server deliberately returns no
  crop at all.
- **All aspect ratios are nevertheless listed in the crop view**
  (#1085 §1b). Before, it built its selection from the AI suggestions — a photo
  without a recognized face thus showed no aspect ratio at all and read as if
  the feature were missing. A tap on a ratio opens the editor already set to
  that crop; where the AI has composed one (marked with ✨), to
  its section, otherwise centered. 2:1 is deliberately absent — neither web nor
  server knows it, so adding it would be a change to all three.
- **A saved edit is visible everywhere, not only in the editor**
  (#1085 §1a). Until then only `PhotoTransformsView` rendered through the
  recipe; every other surface loaded `/photos/file/<filename>`, i.e. the
  unmodified original — the crop was visible in the sheet that made it, and
  nowhere else. Photos with their own recipe now come via
  `GET /photos/:id/render?v=user`; which ones those are is told by
  `GET /photos/transforms/mine` once for the whole app
  (`TransformedPhotosIndex`, like `useTransformedPhotosIndex` on the web).
- **The cache key is the trap.** `ImageCache` lives on disk, so an
  unchanged key survives a restart and would keep delivering the
  pixels from before the edit — the fix would have looked like the bug.
  Rendered photos carry user and a revision in the key, and the
  revision also travels in the query: the render route answers
  `Cache-Control: immutable`, and `URLSession` would otherwise hold the old
  bytes.
- **The disk cache has a limit (500 MB).** Until then it had none —
  every thumbnail ever loaded stayed, and nobody called `clearDisk()`.
  `ImageCache.enforceDiskCacheLimit()` deletes the files unviewed for the
  longest time until the limit is undershot again; a
  disk hit in `image(forKey:)` sets the file's modification date to
  now, which is the LRU signal. `runMaintenanceIfNeeded()` runs for this
  at most once a day, triggered from `ContentView` at startup — no
  directory scan every time the app is opened.
- Deliberately staying with the original: a fullscreen page that draws a
  face frame (the frame lies in the original's coordinates), and the
  download into the device library (the original is the archive copy). Where
  rendering is used, the AI focus point is dropped — the own crop *is* the
  answer to what the photo shows.
- Known gap: a **second** edit made elsewhere (web, second device)
  does not bump a revision here and may be served stale until the cache
  expires. The *first* recipe of a photo always appears,
  because it brings the photo into the index.
- **Edit yourself** (#1019 stage B, `PhotoRecipeEditorView` +
  `PhotoRecipe.swift`), reachable via "Selbst bearbeiten…": drag the crop
  frame, grab the corners, rotate in 90° steps, sliders for exposure,
  contrast and gamma — all with live preview, saved via
  `PUT /photos/:id/transforms`.
- **The crop applies in the unrotated image.** The server crops first
  and rotates afterwards (`photo/photo-transforms-render.service.ts`); a frame
  that moved along when rotating would yield a different section on rendering
  than the editor showed.
- **The preview computes on the device**, not per request: a round trip to the
  server per slider step would be unusable. `PhotoRecipe.toneCurve` is the
  renderer's own curve (exposure × contrast around 128/255, then
  black/white point, then gamma), so that the preview matches the file
  rendered later. A copy scaled down to 1600 px is edited — the
  crop is normalized, the curve applies per pixel, so this changes nothing in
  the result.
- **Gamma below 1 is not promised.** `sharp` accepts only 1…3; the
  preview clamps the same way instead of showing an edit that the file
  does not get.
- **Slider range ≠ server range.** The sliders end at ±2 EV as on the web,
  saving is clamped against the server limits (±3 EV) — a recipe adopted
  from outside is thus not rejected just because it lies beyond the
  slider. The server rejects black point ≥ white point; which of the
  two was meant cannot be told, so both are dropped.
- **Auto-levels does not save.** It measures the pixels *inside* the
  current crop and only fills the sliders; saving happens only with
  "Sichern" (save).

### 2.6c Photo Comparison (Group Review)

- **Comparison view** (`PhotoCompareView`), reachable via "Vergleichen …"
  (compare …) in the group review card as soon as a group has at least two
  photos. Two shots side by side (stacked in portrait).
- The decisive move is the same as on the web: **a tap on a face
  zooms both photos onto it, to the same screen size.** Two independent
  zoomed faces cannot be compared, equally sized ones can. The
  geometry lives in `PhotoCompare.swift` (port of
  `frontend/src/utils/compareZoom.ts`).
- Both zooms are solved **together**: each side needs the dimensions of the
  other photo, otherwise the two halves would arrive at different results.
  The smaller of the two faces is decisive — the other way around, the
  second would run out of its section.
- A tap on a **named** face aligns both sides to the same
  person; without a name there is nothing to match, so the tapped side keeps
  exactly the tapped face and the other takes its own
  main face (`PhotoCompare.anchoredBoxes`). A tap on empty space
  still zooms onto the main face instead of doing nothing.
- **A tap on another face switches the focus directly to it**
  (#1115 §4). Before, every second tap zoomed back out to the whole image without
  checking what was under the finger — from one face to the next took
  two taps and a detour. Now only a tap on the already focused face
  (or on empty space) zooms out. So that this can be hit at all in the zoomed
  state, `PhotoCompare.unzoomed` first maps the tap back onto the unzoomed
  image; unnamed faces are identified by their
  position, otherwise two of them would be the same focus.
- **If the person is on only one of the two photos, the matching falls back to
  the respective main face** (#1085 §2c). Before, the other side returned
  nothing, but `syncedZooms` needs both frames — so *neither* photo
  zoomed, while "Ganzes Bild" (whole image) nevertheless appeared in the
  toolbar. From the outside: tapped, nothing happens, a new button appears.
  Now every tap either zooms or changes nothing at all (`PhotoCompare.matchedBoxes`).
- **Sharpness overlay** (`FocusPeaking`, port of
  `frontend/src/utils/focusPeaking.ts`): every measured face gets a
  frame in traffic-light color plus a percentage value. What is measured is the variance
  of the Laplacian over the face crop, normalized against the same
  full-scale value as in the embedding service — the colors thus agree with the
  AI quality values shown next to them. Can be switched off via the "…" menu.
  The frame is a **hairline** (`chromeScale`, i.e. 1 pt
  computed against the zoom): it lies on exactly the detail the comparison is
  about, and 2 pt covered too much of it (#1115 §3).
- **The toolbar has at most three entries, and the overflow menu is
  ours** (#1115 §2). Five `.primaryAction`s do not fit in an
  iPhone navigation bar, so iOS folded the rest into its own
  "…" menu — what ended up in it depended on the width. Now in the bar:
  "Ganzes Bild" (only while zoomed) and "Zur Auswahl" (to the selection); in our own
  `Menu`: sharpness display, rating, help. "Zur Auswahl" used to be called "Fertig",
  which in a navigation bar means "close screen" — but it only ends
  the pairwise comparisons and jumps to the selection, where nothing has been
  saved yet.
- The **gesture legend** ("?" or "Hilfe") appears on the iPhone as a
  sheet. It had been forced into a real popover via
  `presentationCompactAdaptation(.popover)`, which hung off a button at the top
  edge and had no room — nothing in it was legible (#1115 §1).
- **The edge is skipped, not wrapped.** The embedding service
  approximates the Laplacian with `np.roll`, which wraps neighbors around the edges.
  On a whole photo this is harmless; on a small face crop it turns
  every brightness difference between opposite edges into a
  phantom edge, and a softly lit, blurry face would read as
  sharp. The web deviates for the same reason.
- **"Not measurable" is not "blurry".** Faces without a usable crop
  get no frame at all instead of a red one — for the decision between
  two shots these are different statements. Likewise, faces rendered too
  small stay unframed: a dozen overlapping boxes on a
  group photo say less than none.
- Frame thickness and labeling scale against the zoom, so that a 2 pt line
  does not become a bar when zooming in.
- **Swipe to discard** (`CompareSwipe`, port of
  `frontend/src/utils/compareSwipe.ts`): throwing a photo off the screen
  discards it — the group keeps all the others. Every direction counts **except
  the one pointing at the partner photo**: pushing the two into each other says
  nothing about which one should go. Which direction that is depends on the
  arrangement — stacked in portrait (down/up), side by side in landscape
  (right/left).
- A swipe needs 64 pt of travel (the same value as on the web), so that a
  graze does not throw a photo away; in the zoomed state a drag is
  panning and triggers nothing.
- **Quality breakdown** (`PhotoQualityDetails`, port of
  `compareQualityDetails.ts` + `comparePhotoScore.ts`), via "Bewertung" (rating) in
  the toolbar: per criterion both values side by side, the higher one
  highlighted. That 71 % stands against 68 % says nothing; that one photo is
  sharper and the other better composed is what decides.
- **The breakdown does not come from the review queue.** `ReviewQueuePhoto`
  carries only the overall score. Instead of widening the queue endpoint (the
  details would then be dragged along with every page, for a rarely opened
  table), exactly the two photos are fetched via
  `GET /photos/details` when the comparison is opened — the same approach as on the web. The
  endpoint has always returned `ai_quality_details`; only the client had
  thrown it away in the decoder until now.
- The fresh value overwrites only the quality fields, never the
  curation status — otherwise opening the table would undo a hide made in
  the same session. A fresh `null` falls back to the known value,
  so that a photo not yet fully rated does not lose its rating.
- **"–" means "not measured", not "zero points"**, and a criterion that was not
  measured does not win against a measured one either.
- Sorting is by the raw key, not by the German
  label: this way the table has the same order on both clients, and a reworded
  label does not shuffle it.
  An unknown criterion keeps its raw name instead of disappearing.
- **A verdict does not end the group** (#1085 §2a). It is a
  Swiss-system tournament as on the web (`CompareTournament`): the loser goes
  down, the winner up, *this pair* is done, and next comes
  the pair with the smallest point gap that is still open. Only when no
  pairs are left does the selection go to confirmation — and **once**
  to the server. Before, the first swipe decided for the whole group, so with
  four photos three were never looked at.
- The AI ratings only set the starting points; if they are all close
  together (spread < 0.12 — the normal case for a burst), they are normalized
  within the group, otherwise the absolute assignment would say nothing.
- **An unreviewed group proposes keeping everything**, and the proposal
  is never empty: `pick-photos` requires at least one keeper, and hiding photos
  without any basis is exactly the mistake this replaces.
- Every verdict is also available as a labeled button — discard per side,
  "gleich gut" (equally good), "später" (later) — and the comparison can be ended
  early for long groups. A swipe is invisible and not
  reachable with VoiceOver.
- **These buttons sit in the system toolbar at the bottom**, not in a
  hand-built bar (#1091 §1). A `VStack` of panes and bar pushed
  the bar beyond the bottom edge: the panes are sized against the *whole*
  `GeometryReader` and `ComparePane` pins that size, so nothing
  could shrink to make room. As chrome, the system reserves the height, the
  reader measures the rest — and unlike a floating bar, nothing
  covers the photos that are the point right now.
- **A "?" explains the gestures.** Swiping and the face tap are the
  fast way and completely invisible; the buttons do not explain them,
  so a popover does (`GestureHelp`).
- **From the confirmation there is a way back into the comparison**
  (`resumeComparing`, #1091 §2c). Before, ending was final: the only
  exits were "apply" and "cancel", the latter discarding the whole
  tournament. It is offered only while a pair is actually open; the
  points and the completed pairs stay, what is decided stays decided. The
  preselection is **not** reset in the process — otherwise the second pass would undo the
  toggles set by hand.
- **In the confirmation, a tap on the image opens it large**, not the
  selection (#1091 §2a/§2b): this is the screen on which photos are
  hidden, and it shows them 110 pt large — deciding from a thumbnail is
  exactly what the comparison is meant to avoid. Keep/hide sits on the
  selection icon (44 pt hit area) and additionally in the footer of the fullscreen view,
  so that "look, then decide" does not lead back to the grid.
- **The group review also runs inside an album** (#1085 §2b), via
  "Gruppen-Review" in the overflow menu of the album detail view — the same name
  and the same icon (`checklist`) as in the feed and in the photos hub, so that it reads as
  one feature instead of three different ones.
  `GET /photos/groups` is not album-capable and does not need to be:
  `AlbumGroupReview.scoped` trims each group to the **visible**
  album members and discards those with fewer than two — the same
  client-side intersection as in `AlbumDetailView.vue`. It is permitted with
  `photos.delete`, the permission the server checks on `pick-photos`.
- The full selection stays with the `ReviewSelectionSheet`.

### 2.6d Collage

- **Collage view** (`CollageView`), reachable via "Collage" in the
  selection bar of the album detail view and the gallery (filtered
  timeline, month view) as soon as between 2 and 9 photos are selected.
  Two steps as on the web: first the three curated variants per
  photo count, each drawn with the photos themselves; then the chosen one large
  for editing, with "Zurück" (back) to the selection. The photos fill the cells in
  the order in which they were selected (`SelectionOrder`) — the photo
  tapped first goes into the first, often largest cell. Two photos
  swap places when one is dragged onto the other (as on the web, with a
  preview image following along and the target field highlighted) or when both are
  tapped one after the other. The sheet cannot be dismissed by swiping meanwhile, so that a
  drag downward moves the photo instead of discarding the arrangement.
  The frame of a caption is always 90 % of the canvas wide (as on the
  web); left/right aligns the text to its edge, even a single short
  line.
  A cell is identified by its position, but its tile by the
  photo (`.id(photo.id)`): the tile holds its image loader in `@State`, and
  without the photo ID it kept the old image after a swap.
- The layout rules live in `CollageLayouts.swift` — a port of
  `frontend/src/utils/collageLayouts.ts` with the same table (same IDs,
  names, aspect ratios, cells), so that the same photos yield the same collage
  on both clients.
- **Sharing** renders the canvas on the device (`CollageRenderer`,
  `UIGraphicsImageRenderer`) and hands the JPEG to the share sheet.
  **Saving** exists only if the collage comes from an album (as on the
  web): it uploads the result as an ordinary photo — there is no
  collage endpoint —, adds it to the album and has the
  album reload.
- Export as on the web: 4000 px long edge, JPEG quality 0.92, white gutters
  of 0.6 % of the long edge between the photos (half of that at the edge). The
  preview draws the same gutters, to scale.
- The preview crops each cell with the same `CollageLayouts.coverCrop`
  as the export, against the cell's real aspect ratio — a
  square preview image showed a different section in portrait cells than the
  saved collage.
- The collage gets the capture date of its **newest** source photo plus
  one second (like `getCollageDate` on the web), via `X-Date-Taken`, and thus sorts
  right behind its source photos. The time of day is taken literally, the
  second added in UTC. This header **overrides** the file's EXIF, unlike
  `X-Captured-At`, which only steps in when EXIF yields nothing: a
  freshly rendered collage carries "now" in its pixels and would otherwise be sorted
  far away from its source photos.
- Cell edges are rounded outward to whole pixels, so that no hairline of
  background is left standing between two fields.
- **Text overlay** (#1020 stage C, `CollageText.swift`): any number of
  captions over the whole canvas, movable by finger, in three
  sizes, left/center/right, in white, black, a color from the photos
  themselves, or any color from the color picker. New captions
  stack vertically in the middle as on the web, each one tenth lower.
- **The font size is a fraction of the canvas height**, not a point size —
  0.05 / 0.08 / 0.13 as on the web. Only that way does the preview (a few hundred
  points tall) show the same image as the export (4000 px): the caption
  covers the same share in both.
- **Positioning is by the center point**, normalized (0…1). Changing the
  layout changes the canvas's aspect ratio, but not where the text
  sits within it.
- Wrapping happens between words, measured with the font that is also
  drawn; explicit line breaks are preserved (including empty lines), and
  a word wider than the line is not torn apart in the middle
  — a wrapped name reads worse than one that overhangs.
- Drawing is done with a dark outline under the fill color, so that text stays
  legible even over a busy photo; the outline never gets thinner than 2 px.
- **The color suggestions come from the photos**: scaled down to 64×64, pixels
  bucketed in steps of 16 and scored by frequency × saturation²,
  gray and very dark pixels skipped (they are no good as a font color), results that are
  too similar discarded. White and black always come first.
  All photos of the collage are evaluated, as on the web.
  One deviation from the web: there, rounding can run up to 256 and produces
  a seven-digit, unreadable hex color; here it is clamped at 255.

### 2.7 Feed (Activity, Comments, Reactions)
- **Feed tab** with unread badge (`FeedViewModel.unreadCount`) — counts every
  kind of activity.
- **The badge on the home screen counts something different: unread comments
  from other people** (`CommentBadge`, `GET /feed/unread-comment-count`). Before,
  it showed the number of open similarity groups, set by the
  review notification. That never went away on its own — a cleanup queue
  is never *done* —, so the icon permanently carried a red number for work
  that nobody has to do today; that is how a badge stops meaning anything.
  Now it stands for the only thing one wants to follow up from the home screen:
  someone wrote you something. "Unread" here is the feed's `seen_at`,
  so the badge disappears exactly when the feed tab marks its
  entries as seen — no second notion of read that could drift
  apart.
- **Which photos appear in the photo feed at all** is decided by four
  actions and nothing else: added to an album, favorited,
  commented on, given a description. A corrected
  capture date no longer bumps (that is bookkeeping), a favorite on the other hand
  does now — it did not before. Deleted descriptions
  do not bump either: there is nothing new to read. Server-side in
  `feed/content-feed.service.ts`.
- **Reactions / likes** and **hiding** per photo.
- **View and write comments** (`FeedCommentSection`).
- **Double tap opens the fullscreen view** (and with it pinch-to-zoom via
  `ZoomableImageView`); the photo is fetched via `GET /photos/:id` for this,
  since the feed entry contains only the filename and counters. Hearting is done via the
  heart button, no longer via the double tap.

### 2.8 Backup & Sync (the iOS app's core strength)
- **Automatic upload** (`PhotoSyncService`, `AssetUploadEnqueuer`,
  `UploadQueue`): modes "Alle Fotos hochladen" (upload all photos) / "Nur neue Fotos" (only new photos) /
  "Nur neue ab jetzt" (only new from now on).
- **Background sync** (`BackgroundSyncManager`): on iOS 26.1+ uses the
  `PHBackgroundResourceUploadExtension`, below that `BGProcessingTask` as a
  fallback.
- **Wi-Fi-only** restriction (`wifiOnly`, on by default) for upload and download.
- **Device album → server album mapping** (`ServerAlbumPickerView`,
  "Album-Zuordnungen", i.e. album mappings).
- **Media type selection** and **exclude screenshots**.
- **Two-way sync**: automatic **download** to the device
  (`PhotoDownloadService`, `DownloadSyncPreferences`, `DownloadSettingsView`).
- **Photo hashing** (`PhotoHashing`) for duplicate/recognition purposes.
- **Share extension**: upload photos directly from other apps.

### 2.9 Recaps & Group Review
- **Recaps** (`RecapsListView`, `RecapPlayerView`, issue #759): story-style
  fullscreen player with auto-advance, segmented progress bar, tap to
  page, hold to pause, and swipe down to close. Plus
  trip-map intro, "Damals & heute" (then & now) comparison and optional background music.
  Favorite (heart) and "Aus Rückblick entfernen" (remove from recap) sit in a bar at the
  bottom edge. Everything except the progress bar fades out three seconds
  after the last interaction; a tap brings it back (and does not page
  in the process), every paging and every button press restarts the timer.
  During an intro the bar stays put.
  Entry via the strip in the feed and the feed toolbar. Read-only – recaps
  are created server-side.
- **Group review** (`ReviewQueueView`, issue #761): swipe-based review of
  similar photos against `/photos/groups/review-queue`. Right = accept
  AI suggestion, left = keep all, up = favorite **and** accept;
  with a peer signal additionally "Konsens übernehmen" (accept consensus). Tapping a photo opens
  the zoomable large view (`ReviewPhotoPreview`) and decides nothing – "Nur
  dieses Foto behalten" is a labeled button there, as it is in the
  tile's context menu. Whoever wants to overrule the AI suggestion opens
  "Auswahl anpassen …" (`ReviewSelectionSheet`): every photo with thumbs
  up/down, prefilled from the suggestion, local until the commit – the
  counterpart to the confirmation phase of the web comparison. The large view shows
  the same thumbs, so that the decision can be changed directly on the large image.
  Every gesture has an equivalent button
  (VoiceOver). Progress bar, filter by confidence level and a
  guaranteed single-step **undo** – the newest decision is buffered locally
  and only sent with the next one (or on leaving), because the
  backend knows no "un-review". Deciding requires `photos.delete`.
- **More entry points** (#968): until then there was exactly one — the quiet
  checklist icon in the feed toolbar. `ReviewQueueCount` reads `total` from
  `/photos/groups/review-queue` (`limit=1`) once for the whole app and keeps
  the number up to date locally when a decision is made or undone
  — the server is not asked again for this.
  - **Badge** on the checklist icon (`ReviewCountBadge`).
  - **Entry "Gruppen-Review"** in the photos hub (`AlbumsListView`), at the same
    level as "Alle Fotos" and "Personen" — the iOS counterpart to the web
    menu item in `frontend/src/config/modules.ts`.
  - **Banner in the feed** when something is open, with a jump straight into the review;
    can be dismissed for the current session.
  - **Deep link** `f4milphotos://review-queue` (`AppDeepLink`,
    `CFBundleURLTypes` in `Info.plist`), routed via a `fullScreenCover`
    in `MainTabView` instead of via a tab, because the review queue belongs to
    no tab. Since #768 §5a this is one case among several — see 2.11.
  - **Local notification** (`ReviewQueueNotifier`), checked after every
    background sync: only if the number has risen compared to the last
    reported state, never for the very first state after
    installation (otherwise a newcomer would be greeted with an already existing list).
    **No push infrastructure** — the server has no APNs path;
    this is a purely local check after the sync that runs anyway.
    It sets **no** icon badge any more (see §2.7): the notification itself is
    the right place for "there are new groups", a permanent number on the
    icon was not.
    Can be switched off under Einstellungen → "Hinweis auf neue Gruppen" (notice about new groups).

### 2.10 Settings / Admin
- Profile display (name, e-mail, roles).
- **User management** (`UsersListView`) and **roles & permissions**
  (`RolesView`) – basic admin.
- Sync settings (upload/download), server connection, sign out.

### 2.11 Deep Links and Universal Links (#768 §5a)

- **One parser, one router.** `AppDeepLink` (`App/AppDeepLink.swift`) reads
  two URL forms onto the same destinations: the app's own scheme
  (`f4milphotos://album/12`, `photo/34`, `person/5`, `recap/7`, `recaps`,
  `feed`, `review-queue`, `shared-album/<token>`) and the web routes of the
  configured server (`https://<server>/app/fotos/alben/12`,
  `/app/albums/shared/<token>`, `/app/fotos/personen?personId=5`,
  `/app/fotos/rueckblicke[?recapId=7]`, `/app/fotos/feed`,
  `/app/fotos/review-queue`, `/app/fotos/galerie?photoId=34` as well as the
  legacy redirects `/app/albums/:id` and `/app/photos?photoId=`). A
  web URL on a **different host** is discarded: the app must not react to
  foreign sites that happen to have the same path structure. Parsing
  is pure and covered in `AppDeepLinkTests`, including a round trip of the
  generated URLs (`AppDeepLink.url(for:)`, `webURL(for:serverURL:)`).
- **`AppDeepLinkRouter`** holds the link in `pending` until the tab bar
  exists — a link that arrives on the login screen ends up, after
  sign-in, where it wanted to go, instead of in the feed. `MainTabView` selects
  only the tab; the push itself happens at its root via
  `navigationDestination(item:)` (`albumToOpen`, `personToOpen`,
  `recapsToOpen` in the router, bound in `AlbumsListView` and `FeedView` respectively).
  Photo, recap player and review queue come as a `fullScreenCover`, because
  they belong to no tab.
- **The tab stacks deliberately stay without a `NavigationPath` binding.** The first
  attempt tied the stacks to a path in order to write deep links into it — and
  as a result the album grid lost its scroll position after every fullscreen
  visit: the grids push the viewer via
  `navigationDestination(item:)`, and in a path-bound stack
  SwiftUI rebuilds the source view on going back. Unbound stacks plus
  item destinations at the root are the same pattern the grids themselves
  use. Price: a deep link pushes on top of the tab's current state
  instead of replacing it, and a person arrives directly (without the list
  in between).
- **Shared albums** (`/app/albums/shared/<token>`): the token is resolved via
  `/albums/public/<token>`; if the signed-in person is a member
  (`GET /albums/:id` answers), the app's own album view opens, otherwise the
  public web page in an `SFSafariViewController` (`SafariSheet`) —
  not in Safari itself, because this is a universal link, and Safari would hand
  it straight back.
- **Universal links** need two sides: the server publishes
  `/.well-known/apple-app-site-association` (`web/app-site-association.ts`,
  controlled via `APPLE_APP_IDS`; without the variable it is 404 and everything stays in the
  browser), and the app carries `applinks:$(F4MIL_ASSOCIATED_DOMAIN)` in
  `FKPhotos.entitlements`. The host differs per household and is therefore a
  build setting in the Xcode project, not code. Only paths are claimed that
  the app can actually open — documents, finance and the bare gallery
  stay with Safari. Setup: `DEPLOYMENT.md`, "iOS universal links".
- **All "open X" sources** — notification (`ReviewQueueNotifier`),
  Spotlight (`SpotlightItems.deepLink(forIdentifier:)`), in future widgets and
  App Intents — only produce a URL or an `AppDeepLink` and hand
  it to `AppDeepLinkRouter.shared`.

### 2.12 Spotlight: Photos with Text, People, Albums (#768 §2)

- **What ends up in the index** (`Features/Spotlight/SpotlightIndexer.swift`):
  photos with recognized text (`photo_ocr`, #1029) or a description, plus
  people and albums. Photos without text do not go in — there would be nothing
  for Spotlight to match on; semantic search stays in the app.
  With ~75,000 photos this is a fraction, and Core Spotlight has no limit on
  the count, but it does for thumbnails: photo entries carry
  **none**, a hit shows app icon, text excerpt and date.
- **Delta instead of full reconciliation.** `GET /photos/spotlight-index?cursor=&limit=`
  (`photo/photo-spotlight.service.ts`) returns entries that have changed since
  the cursor — `GREATEST(photos.updated_at, photo_ocr.updated_at)`,
  microsecond-precise, with the photo ID as tie-break —, page by page and in
  order of change. The client stores cursor and ID set after **every** batch
  (`SpotlightIndexState`, the IDs as compact `Data`), so that an
  aborted first run resumes where it stopped. Deletions and lost access
  cannot travel through a delta (the OCR row dies with the photo),
  so after every run `GET /photos/spotlight-index/ids` is diffed against the
  held ID set and the remainder is removed.
- **Visibility like `/photos/details`:** own photos and photos in albums
  that one owns or is invited to. Person names come from the
  own face assignments, because a person is per user.
- **Entry shape** (`SpotlightItems`, tested in `SpotlightItemsTests`):
  title = first line of text (or the description), body = rest, `textContent`
  = everything (this is what Spotlight matches full text on), person names as
  keywords, capture date as `contentCreationDate`, `expirationDate` =
  infinite — the default is one month, after which Spotlight silently forgets
  everything. Text is capped server-side at 2000 characters.
- **When it runs:** after every sync (`BackgroundSyncManager`) and at
  app start, at most every 15 minutes; "Jetzt aktualisieren" (update now) in the
  settings forces it. People and albums are replaced completely when the lists
  are loaded (`replaceDomain`), so that merging and deleting
  carry over. Separate domains `photo`/`person`/`album`, each deletable individually.
- **Privacy:** Recognized text is exactly the kind of content that
  carries personal data (photographed letters, invoices,
  business cards). The index stays on the device, but iPhone search shows
  the snippets to anyone holding the phone. Therefore "Text in Fotos"
  (text in photos) is **opt-in** (Einstellungen → "Suche auf dem iPhone" (search on the iPhone), `SpotlightSettingsView`),
  separate from "Personen und Alben" (on); switching it off deletes the domain,
  signing out deletes everything (`wipeAll`), because the index is per device and the API
  per user.
- **A hit opens** via `onContinueUserActivity(CSSearchableItemActionType)`
  in `ContentView`: `photo:<id>` / `person:<id>` / `album:<id>` become the
  `AppDeepLink` and take the same path as any other link (2.11).
- **Not built:** a Spotlight index extension
  (`CSIndexExtensionRequestHandler`), with which iOS could have the index
  rebuilt after losing the system index without launching the app — it needs a
  target of its own; until then the next app start rebuilds.

### 2.13 Limited Photo Access (#768 §4a)

- Sync accepted `.limited` from the start, but said so nowhere:
  "Alle Fotos hochladen" silently meant "all *shared* photos", and iOS
  laid its own "Weiterhin beschränken / Mehr auswählen" (keep limiting / select more)
  alert over the app at every launch — which read like a bug in the app.
- `PHPhotoLibraryPreventAutomaticLimitedAccessAlert` in the `Info.plist`
  switches off the system alert; instead `LimitedLibraryAccessSection`
  in the sync settings shows the state with the two ways out: "Auswahl
  ändern…" (change selection) (`presentLimitedLibraryPicker`, presented from the frontmost
  view controller, because SwiftUI provides none) and "Vollen Zugriff erlauben"
  (allow full access) (system settings). The footer text names the consequence for linked albums.
- `LimitedLibraryChangeObserver` listens for library changes: under
  limited access an extended selection is the only way a
  new photo can appear, so afterwards (debounced 3 s, only when sync
  is active) a `runFullSync` runs, instead of waiting for the next foreground cycle.
  Separate from the `TripPhotoLibraryObserver`, which decides something different.

### 2.14 App Intents / Siri Shortcuts (#766)

- **The intents live in the app target** (`ios/App/Intents.swift`), not in
  the package. They first lived in the package and were passed over via an
  `AppIntentsPackage` — that worked from Xcode, but not from TestFlight:
  the archive's metadata extraction left out the package intents, and the
  installed app had not a single action in the Shortcuts app. In the
  app target they are extracted on the normal path with every build. Each
  intent is a call into `IntentActions` (`Sources/FKPhotos/App/
  IntentActions.swift`, public facade); the work stays in the package. The
  app shortcuts are in the same file.
  - **Back up now** (`BackUpNowIntent`, without opening the app): checks the toggle,
    network gate and a running backup and then **starts** `runFullSync`,
    without waiting for it — a first run takes minutes, an intent has
    seconds; the sync engine holds its own background task assertion.
    The reply is what is known immediately: started, or why not.
  - **Search photos** (`SearchPhotosIntent`, parameter `query`): opens the
    search tab with the query submitted. New `AppDeepLink.search(query:)`
    (`f4milphotos://search?q=…`, app scheme only — the web has no
    search URL); the router holds the query in `pendingSearchQuery`, `SearchView`
    picks it up as if it had been typed.
  - **Show recap** (`ShowLatestRecapIntent`): fetches `/recaps`, opens the
    newest non-dismissed one in the player; with no recap or offline, the
    list with a spoken explanation.
  - **Open album** / **Show a person's photos** (`OpenAlbumIntent`,
    `ShowPersonIntent`) via `AlbumEntity` / `PersonEntity` with
    `EntityStringQuery`: Siri and Shortcuts query the lists from the server,
    names are matched independent of accents and capitalization ("urlaub" finds
    "Urlaub 2024"). Unnamed people do not appear.
  - **Open group review** (`OpenReviewQueueIntent`).
- **Everything visible goes through the router** (2.11): an intent produces an
  `AppDeepLink` and nothing else, so "Zeige Album Urlaub" via Siri lands
  on the same screen as a Spotlight hit or a link.
- **How Siri hears the app:** The display name "F4mil Photos" has a digit
  in the middle of the word, and how Siri pronounces that is not predictable.
  `CFBundleSpokenName` ("Famil Photos") tells it, and
  `INAlternativeAppNames` in the `Info.plist` additionally lets Shortcuts
  respond to "Famil Photos", "Famil" and "Familienfotos", each with a
  pronunciation hint. Without these keys one would have to speak the name the
  way Siri currently imagines it.
- **Not declared as app shortcuts** are the entity-taking intents:
  a shortcut phrase can carry an entity only as an enumerable parameter,
  albums are open-ended. They remain reachable via the Shortcuts app and Siri's own
  resolution.

### 2.15 Remote Push via APNs (#765)

- **One sender, two channels.** `sendToUser` in the `push` service sends
  the same notification via Web Push to browsers and via APNs to
  iPhones; preferences, debouncing, online suppression and digest upstream of
  it are shared. Details: `documentation/push-notifications.md`, "iOS: APNs".
- **`RemotePushManager`** (`Features/Push/`): opt-in as on the web. On
  enabling, ask for permission, fetch the token
  (`registerForRemoteNotifications`), hand it to `POST /push/apns/register` —
  and do so **again on every launch**, because the token can change and
  the server knows only the latest. Switching off and signing out call
  `/push/apns/unregister`, so that a second account on the same phone
  does not receive the first one's notifications. Sandbox or production
  is decided by the build configuration (`#if DEBUG`), exactly as Xcode assigns the
  `aps-environment` entitlement.
- **A tap opens the place.** The payload carries the web-relative path
  (`/app/fotos/alben/12?photoId=34`) that every feed notification has anyway;
  `AppDeepLinkRouter.handle(urlString:)` resolves it against the
  configured server and routes it like a universal link (2.11).
  The `default` branch of the notification delegate in `Main.swift` thus
  applies to remote push and the local review notification alike.
- **`PushSettingsView`** (Einstellungen → Benachrichtigungen, i.e. notifications): the toggle
  for this iPhone with status (active, registering, denied in iOS,
  error), the kinds as in the web profile (`/push/preferences`, one set for all
  devices, only the photo kinds — the app has no documents) and the toggle
  for the local group notification, which previously sat in the main list.
  If the server is not set up (`GET /push/apns/status`), the
  toggle is off and says why.
- **Entitlement** `aps-environment = development` in `FKPhotos.entitlements`
  (Xcode sets it to `production` when archiving). Xcode creates the push capability
  on the App ID with automatic signing.

---

## 3. Comparison: Web Photo Area ↔ iOS

Legend: ✅ present · ⚡ present & superior · 🔶 partial/different · ❌ missing

### 3.1 View & Navigation
| Feature | Web | iOS |
|---|---|---|
| Chronological timeline / "Alle Fotos" | ✅ virtual scroll | ✅ year → month |
| Filter (favorite, GPS, date, media type) | ✅ | ✅ (favorite, GPS, date) |
| Sorting (date/quality/name/size) | ✅ | 🔶 (subset) |
| Fullscreen + zoom | ✅ | ✅ native pinch zoom |
| Slideshow | ✅ mode in fullscreen | ✅ own story player (`PhotoSlideshowView`), with photo pairs depending on device orientation |
| Multi-select + batch actions | ✅ (gallery + album) | ✅ (album, month and "Alle Fotos") |
| Compare photos | ✅ `PhotoCompareView` | ✅ `PhotoCompareView` (side by side, synchronized face zoom, sharpness overlay, swipe to discard, quality breakdown) |

### 3.2 Photo Actions
| Feature | Web | iOS |
|---|---|---|
| Favorite | ✅ | ✅ |
| Hide / unhide | ✅ | ✅ (feed + fullscreen) |
| Delete | ✅ | ✅ (with `photos.delete`) |
| Download original | ✅ | ✅ (into the Photos library) |
| Share (native) | 🔶 (link) | ⚡ iOS share sheet |
| Add to album | ✅ | ✅ |
| Remove from album | ✅ | ✅ (in album context) |
| Change capture date | ✅ | ✅ |
| Set/change GPS location | ❌ (not on the web either — only `POST /photos/:id/rescan-gps` re-reads EXIF) | ❌ |
| Map over a collection (stops/trip) | ✅ `TripMap` | ✅ `PhotoMapView` (pins, timeline, zoom clustering) |
| Reindex / refresh metadata | ✅ | ❌ |
| Non-destructive transformations (crop/rotate) | ✅ `PhotoTransformEditor` | ✅ `PhotoTransformsView` (view/apply/adopt/reset) + `PhotoRecipeEditorView` (cropper, rotation, tone sliders, auto-levels) |
| Create collage | ✅ `CollageDialog` | ✅ `CollageView` (layouts, preview, render + upload, text overlay) |

### 3.3 Metadata
| Feature | Web | iOS |
|---|---|---|
| EXIF/metadata sidebar | ✅ | ✅ |
| Quality score display | ✅ | ✅ |
| Per-photo map | ✅ | ✅ |
| Recognized faces + naming | ✅ | ✅ |

### 3.4 Albums
| Feature | Web | iOS |
|---|---|---|
| List / create / delete | ✅ | ✅ |
| Pin album | 🔶 | ⚡ (pin + swipe actions) |
| View modes (all/favorites/consensus/custom) | ✅ | ✅ `AlbumViewMode` |
| Consensus / anonymous voting | ⚡ | ✅ (badges "3/5" + favorite vote) |
| Share with users (roles) | ✅ | ✅ |
| Public links (with expiry) | ✅ | ✅ |
| Edit album (name, description, map mode) | ✅ | ✅ `AlbumSettingsView` |
| Set cover | ✅ | ✅ (grid context menu, `AlbumCover`) |
| Upload to album | ✅ | ✅ |

### 3.5 People & Faces
| Feature | Web | iOS |
|---|---|---|
| People grid, rename, merge, ignore | ✅ | ✅ |
| Year tiles per person | ❌ | ⚡ (new) |
| Birthday / age at time of capture | ❌ | ❌ |

### 3.6 Search
| Feature | Web | iOS |
|---|---|---|
| Semantic / natural language | ✅ | ✅ |
| Place / POI / radius | ✅ | ✅ (same backend) |
| Filter chips / structured filter UI | ✅ `NaturalSearchBar` + chips | ✅ `SearchParseChips` |

### 3.7 Feed / Social
| Feature | Web | iOS |
|---|---|---|
| Activity feed (album activity) | ✅ | ✅ (badge) |
| Photo stream (chronological) | ✅ `PhotoFeedView` | 🔶 (feed = activity) |
| Reactions / likes | ✅ | ✅ |
| Comments (read + write) | ✅ | ✅ |
| Push notifications | ✅ (PWA push) | ✅ (APNs, #765 — see 2.15) |

### 3.8 Recaps & Review
| Feature | Web | iOS |
|---|---|---|
| Recaps – player | ✅ `RecapsView`/`RecapPlayer` | ✅ `RecapPlayerView` |
| "On this day" / memories | 🔶 (via recaps) | 🔶 (via recaps) |
| Group review (review queue) | ✅ `ReviewQueueView` | ✅ `ReviewQueueView` (swipe) |

### 3.9 Backup & Sync
| Feature | Web | iOS |
|---|---|---|
| Manual upload | ✅ | ✅ |
| Auto-backup in the background | ❌ | ⚡ |
| Wi-Fi only | ❌ | ✅ |
| Device album → server album mapping | ❌ | ✅ |
| Exclude screenshots / media types | ❌ | ✅ |
| Two-way sync (download to the device) | ❌ | ✅ |
| Upload queue + retry | ❌ | ✅ |
| Share extension (upload from other apps) | ❌ | ✅ |

### 3.10 Auth & Admin
| Feature | Web | iOS |
|---|---|---|
| Password + passkeys | ✅ | ✅ |
| User/role management | ✅ (complete) | 🔶 (basic) |
| Data management / jobs / purge | ✅ | ❌ (deliberately web) |

---

## 4. Plan: Feature Parity (only where sensible)

Prioritized by benefit ÷ effort and "does this fit on a phone?".

### Stage 1 – High benefit, obvious on mobile *(implemented)*

All four items are present in the app; the descriptions remain as a
reference for what was built in each case.

1. ✅ **Recaps viewer** – Story-style playback is ideal on the phone.
   Read-only consumption of the existing `/recaps` data + a `RecapPlayer`
   counterpart in SwiftUI (`TabView` paging, auto-advance, optional music).
2. ✅ **Album view modes + consensus/voting** – the app's unique selling point
   (collaborative curation). Modes "All / Favorites / Consensus",
   favorite toggle per album member, "3/5 favorites" display.
3. ✅ **Group review (review queue)** – Swipe-based review (left/right)
   fits touch superbly.
4. ✅ **Complete the photo actions in fullscreen** – hide/unhide,
   remove from album, delete (with permission), download original.
   Closes everyday gaps; uses existing endpoints.

### Stage 2 – Medium benefit
5. ✅ **Interactive map/trip view** – map with photo clusters,
   stop timeline and zoom-dependent re-clustering, implemented as
   `PhotoMapView` on the basis of the ported `PhotoStops` rules (#1016).
   *Assigning a place via a map pin* does not belong here — the web cannot do that
   either, so it is not a parity gap.
6. ✅ Create **public album links** and share them via the share sheet
   (expiry date) – implemented in `AlbumShareView`; the shared link points to
   the SPA route `/app/albums/shared/<token>` (`AlbumPublicLinkURL`).
7. ✅ **Multi-select in "Alle Fotos"** incl. batch actions – implemented
   in `PhotoTimelineView` (filtered flat view) on the basis of the
   shared `PhotoSelection` state.
8. ✅ **Richer search filters (chips)** – search now goes to
   `/photos/search/natural` (place and time range filter instead of being
   searched as words) and shows the server's reading as "Verstanden als" (understood as) chips
   (`NaturalSearch`, `SearchParseChips`), analogous to `NaturalSearchBar`.
9. ✅ **Slideshow** – implemented as its own fullscreen player
   (`PhotoSlideshowView`), the same story player as for the recaps.
   Startable from album, selection, library and the fullscreen viewer; pure logic
   in `SlideshowPlan.swift`, rules in `documentation/photo-slideshow.md`.

### Stage 3 – Nice-to-have / more effort
10. ✅ **Non-destructive transform/crop editor** – `PhotoTransformsView`
    (view/apply suggestions, adopt someone else's version, reset,
    #1019 stage A) and `PhotoRecipeEditorView` (cropper, rotation, tone
    sliders, auto-levels, stage B).
11. **Collage creation**.
12. ✅ **Compare photos** – `PhotoCompareView` in the group review: two
    shots side by side, a tap on a face zooms both onto it at equal size
    (#1021 stage A), plus sharpness overlay, swipe to discard and
    quality breakdown (stage B).

### Deliberately **not** ported (web makes more sense)
- Full data management, scheduled jobs, purge → remains web/admin domain.
- Guest/public-link recipient flows (guest dialogs) → web concept.
- CLI/bulk upload.

---

## 5. iOS-Specific Extensions (only sensible on iOS)

These features make sense primarily or exclusively on the device and would be
a real enrichment:

1. **"Free up storage"** – remove already backed-up original photos from the device
   (Immich style), incl. "only confirmed uploaded".
2. ✅ **Home screen widgets** (#764) – "On this day", latest recap,
   newest feed activity. Its own WidgetKit extension target
   `FKPhotosWidgets` (`App/Widgets/`), which shares the extension target with the
   Live Activity (item 3) instead of opening a second one. The data
   comes without new server code: `WidgetSnapshotStore` (in the package)
   writes, on every load of recaps/feed that takes place anyway,
   a small JSON snapshot into the same app-group `UserDefaults` suite
   that the share extension already uses (`SharedStorage`,
   `group.de.f4mil.photos`); the extension only reads. The photo for it (cover
   of the recap, the feed photo itself) comes in a second step: the
   disk cache from #1293 lives in the app's private caches directory, which the
   extension does not see, so the app loads the image once at
   widget size (`/photos/file/…?w=800&convert=true`) and stores it as JPEG
   in `widget-images/` in the app-group container (`WidgetImageStore`, one
   file per widget). The snapshot names the file name, the widget shows
   the photo as background under the text; without a file it remains the
   text card. A recap that already has its cover does not reload it on the
   next list fetch; a new recap in the same slot does not
   inherit the old image. "On this day" and "latest recap" adopt
   the same selection rule as the "Show recap" App Intent (2.14):
   unseen first, otherwise the newest. Signing out deletes snapshots and
   images (`WidgetSnapshotStore.clearAll`) for the same reason as the
   Spotlight index: the extension checks no session, otherwise the
   home screen would show the next account the photo and names of the previous one.
3. ✅ **Live Activity / Dynamic Island** (#768 §1) — for the current day
   of a trip plan, not for backup progress (there is no need for that:
   the backup runs unobtrusively in the background, whereas a travel day
   is the situation in which a glance at the lock screen widget
   actually helps). Shows the current block, the confirmed or
   presumed stop, a delay indicator and a light hint when
   one is still upcoming. `TripDayActivityManager` (in the package) keeps the
   activity current in the foreground via 60-second polling — ActivityKit
   throttles updates to about one minute anyway, so calling more often
   costs nothing extra — and ends it by itself as soon as the
   day is over or no plan is running any more; no server push needed, since
   everything is computed locally from the plan bundle, which can be loaded
   for offline use anyway (§3.9). `TripVisitMonitor.openStopOsmRef`
   delivers the geofence-confirmed stop and wins over the plan's pure
   time-of-day guess.
4. ✅ **App Intents / Siri Shortcuts** – "Back up now", "Search for …",
   "Show recap", album/person as entity — see 2.14.
5. **Local notifications** – "new groups waiting" is implemented
   (`ReviewQueueNotifier`, 2.9); "backup completed" deliberately not, since there is
   no widget/Live Activity for it (see item 3) — a push
   on demand would suffice here, but is not part of this stage.
6. ✅ **Remote push (APNs)** – counterpart to the existing `push` service &
   PWA push — see 2.15.
7. ✅ **Spotlight indexing** — photos with recognized text (opt-in),
   people and albums — see 2.12.
8. **Live Photos** – capture/upload of the motion component (once the backend
   supports video/motion; currently purely photo-based).
9. ✅ **Limited library picker polish** (PhotoKit) — see 2.13. Focus filter
   deliberately left open (#768 §4b).
10. ✅ **Deep links & universal links** between iOS and web — see 2.11.
    Handoff open (#768 §5b).

---

## 6. Open Documentation Items

- `FEATURE_COMPARISON.md` section 8 ("Mobile Apps") and the summary
  were updated with this state (iOS is no longer "read-only").
- The sync architecture (upload queue, background task, hash matching,
  two-way sync) is documented in [`ios-backup-sync.md`](./ios-backup-sync.md).
- The album view modes, including the rationale for why iOS filters on the device
  instead of storing `active_view`, are in
  [`album-photo-views.md`](./album-photo-views.md).
- The swipe variant of the review queue, including the gesture table and the behavior
  of the single-step undo, is in [`ai-auto-pick.md`](./ai-auto-pick.md).
