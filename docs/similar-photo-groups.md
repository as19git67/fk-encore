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

### Album-specific restriction

In the album view, groups are additionally constrained to album members
(`albumPhotoGroups` in `AlbumDetailView.vue`):

```ts
// Simplified sketch
for (const g of photoGroupsList.value) {
  const membersInAlbum = g.photo_ids.filter(id => albumPhotoIds.has(id))
  if (membersInAlbum.length < 2) continue           // not relevant
  const coverInAlbum = albumPhotoIds.has(g.cover_photo_id)
    ? g.cover_photo_id
    : membersInAlbum[0]                              // fallback
  result.push({ ...g, photo_ids: membersInAlbum, cover_photo_id: coverInAlbum })
}
```

This means:

- Only groups with **≥ 2 members in the current album** appear.
- Members outside the album are filtered out of the group view.
- If the original cover is not in the album, an in-album member is used as
  the cover.

### Robustness against transient double groups

`photoToGroup` can transiently contain both a reviewed and an unreviewed
group for the same photo (e.g. right after adding a photo to a shared
album, before the cleanup logic has run). The map-building logic therefore
iterates **reviewed first, then unreviewed** – the unreviewed one wins
and drives the stack icon and click behavior.

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
  when an embedding job finishes.
- `db/schema.ts` – `photoGroups`, `photoGroupMembers`.
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
