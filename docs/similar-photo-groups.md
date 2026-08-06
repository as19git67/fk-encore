# Similar Photos – Grouping and Review

## Overview

The feature detects visually similar photos (bursts, multi-exposure shots,
near-identical duplicates) and presents them as a stack. Users can step
through each group in `PhotoCompareView`, hide or favorite individual photos,
and finally mark the group as "done" (reviewed).

This document describes how the grouping is computed, how it behaves with
respect to shared albums, and what happens when group members change later.

## Data model

| Table | Purpose |
|-------|---------|
| `photo_groups` | One row per user per similarity cluster. Contains `user_id`, `cover_photo_id`, `reviewed_at`, `created_at`. |
| `photo_group_members` | M:N link from the group to its photo members, including `similarity_rank`. |

Important: `photo_groups` has **no** album reference. Groups are
**user-specific**, not album-specific. This means:

- Every user has their own view of similarity clusters.
- `reviewed_at` applies to that one user only.
- Two users (e.g. the owner and a participant of a shared album) have
  separate group rows with independent review status.

## Detection pipeline

Detection runs in `findPhotoGroupsLogic(userId)` in `photo/photo.service.ts`:

1. **Photo collection** – loads all photos the user has access to:
   - Own photos (`photos.user_id = userId`)
   - Photos from shared albums (`album_shares` ⋈ `album_photos` ⋈ `photos`)
   - Both sets are deduplicated via a map.

2. **Embedding fetch** – retrieves DINOv2 embeddings for all collected
   photo IDs from the embedding service (`EMBEDDING_SERVICE_URL`).

3. **Windowed pair comparison** – sorts by timestamp and compares each photo
   only with photos within a 10-minute window (`TIME_WINDOW_MS`). Pairs
   with cosine similarity ≥ 0.90 (`SIMILARITY_THRESHOLD`) are connected
   via union-find.

4. **Cluster formation** – connected components with at least 2 members
   become groups. The center (highest average similarity) becomes the
   `cover_photo_id`.

5. **Persistence** – writes new groups in a transaction:
   - Deletes all existing **unreviewed** groups of the user.
   - Preserves reviewed groups via member-set comparison (see below).

## Review preservation and snapshot logic

The review status is tied to a concrete member snapshot.

When rebuilding the groups, `findPhotoGroupsLogic` checks for each freshly
computed cluster:

```
for every reviewed group:
  if member set is identical   → do not create new group (group stays reviewed)
  if member set is strict subset → delete old reviewed group (obsolete)
  else                           → independent; old reviewed group remains
```

This has two consequences:

- **Unchanged clusters stay reviewed**: as long as the members are the same,
  the user does not see the group again.
- **Extended clusters are shown again**: if a new photo joins (e.g. upload
  of a similar new photo, or a photo added to a shared album), a new cluster
  with a larger member set appears. The snapshot no longer matches – a new
  **unreviewed** group is created, and the old reviewed (now obsolete)
  subset is deleted. The user has to confirm the extended group once again.

## Triggers for re-grouping

`findPhotoGroupsLogic(userId)` is triggered from several places:

| Event | Triggered by | For which users |
|-------|--------------|-----------------|
| Embedding job finished | `scan-worker.ts` | All users with access to the photo (owner + all shared-album participants), determined via `getUsersWithPhotoAccess` |
| Album is shared with a user | `shareAlbumLogic` | The newly added participant |
| Photo is added to an album | `addPhotoToAlbumLogic` | All shared users of the album |
| Album share is revoked | `removeAlbumShareLogic` | The removed participant (so that lost photos disappear from their groups) |
| Manual trigger | `POST /photos/find-groups` | The calling user |

The calls are fire-and-forget with error logging so that the API response
is not blocked.

### Per-user serialization

All triggers go through `scheduleRegroup(userId)` (`photo.service.ts`). This
function guarantees:

- **Mutex**: at most one `findPhotoGroupsLogic` instance per user runs at
  any time.
- **Coalescing**: if multiple further triggers arrive while a computation
  is running, they are merged into exactly one follow-up run that then sees
  the latest DB state.

This matters because `findPhotoGroupsLogic` starts its transaction by
deleting all of the user's unreviewed groups and then inserts the freshly
computed clusters. Without serialization, two parallel triggers (e.g. a
quick "photo 1 and photo 2 into the album" double click) could interact
as follows: the older trigger read a smaller photo snapshot (`[1]`),
therefore computes no cluster; it then commits its `DELETE` and wipes
out the group `{1,2}` that the newer trigger had just inserted.

The manual endpoint `POST /photos/find-groups` also waits for the
scheduler (including any already queued follow-up run) before returning
the current group statistics.

## Frontend rendering

### General mechanics

The two views `PhotosView` ("All photos") and `AlbumDetailView` share the
same UI logic:

- `listPhotoGroups()` is called on load.
- The `usePhotoGrouping` composable is given `hiddenByStack` and
  `photoToGroup`.
- For every **unreviewed** group, only the cover photo is shown in the
  grid; the remaining members are hidden via `hiddenByStack`.
- Clicking the stack (`@stack-click`) opens `PhotoCompareView`.
- The button **"Edit groups (N open)"** jumps to the first unreviewed group
  via `handleStartGroupReview`.

### Compare-view zoom helpers (Track N)

Inside `PhotoCompareView` the user can inspect a specific face without
leaving the side-by-side layout:

- **Double-click / double-tap** on a photo zooms in on the face nearest
  the click position. With multiple people in the frame the gesture
  decides the target (`pickBboxAtPoint` in `utils/compareZoom.ts`) — the
  face whose bbox contains the click wins, ties broken by the tightest
  bbox; otherwise the nearest face within ~15% of the image diagonal;
  otherwise the global "primary" bbox.
- **Sync-Zoom toggle** in the header mirrors the zoom to the other
  photo. When the clicked face has a `person_id`, the counterpart on
  the other photo zooms to that same person via `findFaceForPerson`;
  otherwise the other photo's primary bbox is used. Both photos are
  equalised to the same on-screen face size by `computeSyncBboxZoom`,
  letterbox-aware via `containedRect`.
- Zoom resets on **ESC**, on Sync-Zoom toggle, on pair change, and on
  window resize.
- Faces (and landmarks when no face is detected) are fetched lazily on
  first double-click and cached per photo.

### Eyes-closed hint (Track N / #81)

`ai_quality_details.eyes_open` already drives the global auto-pick
weighting (see `docs/ai-auto-pick.md`). The compare and review tiles
surface low scores directly:

- Each photo with `eyes_open < 0.5` shows a red "Augen zu" pill in the
  bottom-right.
- In the compare phase, the pill is intensified (stronger red + glow)
  when the OTHER photo of the pair has open eyes — that's the
  actionable "pick the other one" case.
- The review-grid tiles render the same pill in a compact variant.

### Focus peaking (#873)

Picking between near-identical shots usually comes down to "which one has
the faces in focus?". In the compare phase every detected face gets a
frame coloured by the sharpness of that face region, plus a small
percentage label:

| Colour | Level | Normalised score |
|--------|-------|------------------|
| green  | in focus (`sharp`) | ≥ `SHARP_MIN` (0.45) |
| yellow | middling (`medium`) | ≥ `MEDIUM_MIN` (0.18) |
| red    | out of focus (`unsharp`) | < `MEDIUM_MIN` |

- A **Fokus-Peaking toggle** in the compare header switches the frames
  off. It defaults to **on** and the choice is persisted under the
  `focus_peaking_enabled` localStorage key
  (`composables/useFocusPeaking.ts`).
- Sharpness is measured **in the browser**, off the `<img>` element that
  is already on screen — no extra request, no schema change, and it works
  on the whole existing library without a re-scan. Photo files are served
  from the app's own origin, so the canvas stays untainted; if
  `getImageData` throws anyway, that photo simply renders no frames.
- The metric mirrors the embedding service's `face_sharpness` (see
  `embedding_service/app/api/endpoints.py`): crop the face bbox, resample
  to 128×128, grayscale, variance of the discrete Laplacian, normalised
  against the same full-scale value (500). Mirroring it keeps the colours
  consistent with the KI quality scores shown next to them.
- **One deliberate deviation:** the service approximates the Laplacian
  with `np.roll`, which wraps neighbours around the crop edges. That is
  harmless on a whole photo, but on a small face crop the wrap turns a
  brightness difference between opposite edges into a bogus edge and a
  soft face reads as sharp. The frontend skips the border row/column
  instead of wrapping (`laplacianVariance` in `utils/focusPeaking.ts`).
- Frames render inside `HeicImage`'s slot, which tracks the rendered
  image rect, so the normalised bbox percentages stay aligned under
  `object-fit: contain` and under the zoom-to-face transform above.
  Ignored faces and bboxes in a foreign coordinate space are skipped.
- Faces come from the same lazily-fetched, per-photo cache the zoom
  helpers use (`getPhotoFacesCached`); measurement runs once per photo
  per session, triggered by the image `load` event, by a pair change, or
  by switching the toggle back on.
- A face rendering below `MIN_RENDERED_FACE_PX` (40 CSS px on the smaller
  side) gets no frame at all — a coloured sliver conveys nothing, and a
  wide crowd shot can have dozens of tiny detections whose frames and
  percentage labels would otherwise stack into unreadable clutter. The
  on-screen size is derived from `containedRect` (the same object-fit
  letterbox math the zoom helpers use), scaled by whatever zoom-to-face
  factor is currently active — zooming into a face can bring it back
  above the threshold (`renderedPhotoGeometry` / `isRenderedFaceLegible`).
- The box's rectangle lives inside the zoom-to-face wrapper, so it's
  meant to scale up with the zoom (it has to keep tracing the actual face
  edges) — but the frame's border and label are UI chrome, not part of
  the traced box, and scaling those too made a 2px outline read as a
  thick smudge once zoomed in. `peakChromeScale(zoom)` (clamped at
  `MIN_PEAK_CHROME_SCALE` so it never thins into an invisible hairline)
  feeds a `--peak-scale` CSS custom property that the border, shadow,
  radius and label counter-scale against, keeping their on-screen size
  constant regardless of zoom.

The scoring maths lives in `frontend/src/utils/focusPeaking.ts` (DOM-free
and unit-tested); the canvas plumbing and the persisted switch live in
`frontend/src/composables/useFocusPeaking.ts`.

### Album-specific restriction

In the album view, groups are additionally constrained to album members that
are still **visible** (not hidden via curation). The scope set is
`visibleAlbumPhotoIds` (album photos whose `curation_status !== 'hidden'`):

```ts
// Simplified sketch
for (const g of photoGroupsList.value) {
  const membersInAlbum = g.photo_ids.filter(id => visibleAlbumPhotoIds.has(id))
  if (membersInAlbum.length < 2) continue           // nothing left to compare
  const coverInAlbum = visibleAlbumPhotoIds.has(g.cover_photo_id)
    ? g.cover_photo_id
    : membersInAlbum[0]                              // fallback
  result.push({ ...g, photo_ids: membersInAlbum, cover_photo_id: coverInAlbum })
}
```

This means:

- Only groups with **≥ 2 visible members in the current album** appear.
- Members outside the album — or already hidden — are filtered out of the
  group view (see "Hidden members and group resolution" below).
- If the original cover is not in the album, an in-album member is used as
  the cover.

### Robustness against transient double groups

`photoToGroup` can transiently contain both a reviewed and an unreviewed
group for the same photo (e.g. right after adding a photo to a shared
album, before the cleanup logic has run). The map-building logic therefore
iterates **reviewed first, then unreviewed** – the unreviewed one wins
and drives the stack icon and click behavior.

## Hidden members and group resolution

Hiding a photo writes a per-user `photo_curation` row (`status = 'hidden'`); it
does **not** remove the photo from `photo_group_members`. A group is only worth
reviewing while at least **two of its members are still visible**, so visibility
is taken into account in three places:

- **Grid badge** (`gallery-grid.service.ts`, `loadGroupInfoForPhotos`): the
  member count joins `photo_curation` and counts only non-hidden members; a
  group with fewer than two visible members gets **no badge** (nothing left to
  compare). The count drives the `+N` badge.
- **Compare view** (`PhotoCompareView.vue`, `groupPhotos`): members that were
  already hidden when the review opened are excluded — they are not re-fetched
  and not shown. An in-session hide keeps its tile (via `localCuration`) so
  undo still works.
- **Review queue** (`group-auto-pick.service.ts`, `listReviewQueueLogic`):
  groups with fewer than two visible members are excluded from the queue and
  its counts (including the high-confidence backlog).

### Auto-resolve

When hiding a photo drops its group below two visible members, there is nothing
left to compare. `updatePhotoCurationLogic` (`photo.service.ts`) detects this
and marks the group `reviewed_at`, so it leaves the unreviewed set instead of
lingering forever with a suppressed badge.

The one-off migration `db/migrations/postgres/0094_resolve_shrunk_photo_groups.sql`
backfills this for groups that shrank (hides or hard-deleted members) before the
auto-resolve existed: every unreviewed group with `< 2` visible members (counted
per group owner) is marked reviewed at startup. It is idempotent
(`reviewed_at IS NULL` guard).

## Live refresh after async scans

Grouping and quality scoring run asynchronously after upload, so the album view
would otherwise show stale data until a remount (badges not yet tappable, `?%`
quality). The backend emits a coalesced per-user realtime event
`photos/scan.updated` (`photo/scan-refresh-events.ts`) when:

- re-grouping completes (`scheduleRegroup`), and
- a quality job completes (in `scan-worker.ts`, reusing the recap access lookup).

`AlbumDetailView` subscribes and, debounced, refreshes the cached group list and
album photos (badges become tappable, quality fills in) and re-anchors the grid
so new badges appear. As a fallback, tapping a badge whose group isn't cached
yet also triggers the same refresh on demand.

## Scenario: review in a partial album

Starting situation:
- Group G = {A, B, C} (all three are visually similar).
- Shared album contains only A and B.
- Participant reviews within the album.

Flow:

1. Participant opens the album → sees the stack [A, B] (C is not in the album).
2. Participant curates A and B (hide / favorite) and clicks **Done**.
3. `reviewPhotoGroup(id)` sets `reviewed_at` on their user-group [A, B].
4. Photo C is not seen and not curated.
5. Later, the owner adds C to the album.
6. `addPhotoToAlbumLogic` triggers `findPhotoGroupsLogic(participant)`.
7. New cluster computation: the participant now sees C too → cluster {A, B, C}.
8. Snapshot comparison: {A,B,C} ⊃ {A,B} → old reviewed [A, B] is deleted,
   new unreviewed [A, B, C] is created.
9. Participant opens the album → button "Edit groups (1 open)" appears,
   stack [A, B, C] is visible and can be reviewed again.

## Relevant files

- `photo/photo.service.ts`
  - `findPhotoGroupsLogic` (grouping + preservation + cleanup)
  - `getUsersWithPhotoAccess` (owner + all shared users of a photo)
  - `reviewPhotoGroupLogic` (sets `reviewed_at`)
  - `addPhotoToAlbumLogic`, `shareAlbumLogic`, `removeAlbumShareLogic`
    (trigger re-grouping for the affected users)
- `photo/scan-worker.ts` – triggers re-grouping for all users with access
  when an embedding job finishes; emits `photos/scan.updated` after quality.
- `photo/gallery-grid.service.ts` – `loadGroupInfoForPhotos` (grid badge,
  visible-member count + suppression).
- `photo/group-auto-pick.service.ts` – `listReviewQueueLogic` (review queue,
  excludes groups with < 2 visible members).
- `photo/scan-refresh-events.ts` – coalesced `photos/scan.updated` realtime
  fan-out so open views refresh after async scans.
- `db/migrations/postgres/0094_resolve_shrunk_photo_groups.sql` – backfill that
  resolves groups already shrunk below two visible members.
- `db/schema.ts` – `photoGroups`, `photoGroupMembers`, `photoCuration`.
- `frontend/src/views/PhotosView.vue` – global view.
- `frontend/src/views/AlbumDetailView.vue` – album-scoped view.
- `frontend/src/components/PhotoCompareView.vue` – review / compare overlay.
- `frontend/src/composables/usePhotoGrouping.ts` – grid grouping including
  stack collapsing.

## Tuning constants

| Constant | Value | Location |
|----------|-------|----------|
| `SIMILARITY_THRESHOLD` | 0.90 | `photo.service.ts` |
| `TIME_WINDOW_MS` | 10 minutes | `photo.service.ts` |

The high threshold is intentional – the target is near-duplicates / bursts,
not thematically similar shots. The time window prevents false matches
between unrelated events.
