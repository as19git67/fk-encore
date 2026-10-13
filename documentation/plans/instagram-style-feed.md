# Instagram-style content feed (chronological, viewer-exact)

Status: **Implemented** (stages 1–4) · Branch: `claude/instagram-style-feed-nnjJ2`

## Implementation status

- ✅ **Stage 1 — Data layer**: Migration `0096_photo_feed_entries` + index + backfill, Drizzle schema, journal.
- ✅ **Stage 2 — Fan-out/reconcile**: `feed/content-feed.service.ts`, hooked into add/batch/share/unshare/leave/delete/metadata/comment; 11 tests.
- ✅ **Stage 3 — Read endpoint**: `GET /feed/photos` (keyset cursor), like/comment enrichment, hidden exclusion, realtime signal; 6 tests.
- ✅ **Stage 4 — Frontend**: `PhotoFeedView` (menu item „Stream"), `PhotoFeedCard`, infinite scroll, double-tap like (= favorite), inline comments, realtime refresh, Storybook story.

Tests: backend 67 files / 1020 green, frontend 19 / 202 green.

## Goal

A second feed next to the existing **notification feed** (`feed_items`):
a scrollable **content stream of photos** in the style of the Instagram main feed —
large post cards, infinite scroll, inline comments and likes,
**strictly deterministic with no ranking algorithm**.

The existing `feed_items` feed (activity/notifications, heart-icon tab)
**stays unchanged** and continues to serve as the notification tab.

## Core decisions (agreed with the user)

### Feed unit
- Unit = **the photo**, **once per user**.
- A photo appears in user A's feed if it is in **at least one album** in which
  A **participates** (owner `albums.user_id` **or** an entry in
  `album_shares`). Guests (link access) are excluded.

### Sorting: strictly chronological by "last relevant activity"
Sort key = the newest of the following events **per photo**:
1. Photo **added to the album** (`album_photos.added_at`)
2. **Metadata** edited (description/keywords/date → `photos.updated_at`, via trigger)
3. **Comment** created/edited (`photo_comments.created_at` / `edited_at`)

→ Behavior = "most recently active on top" (bump), **not** a plain creation date.
→ **No** ranking, no engagement weighting.

**Addendum:** A photo only gets into the feed through four actions — it was
added to an album, favorited, commented on, or given a description.
Everything else that touches a photo (corrected capture date,
crop, re-scan) is bookkeeping and does not bump. Favorites have bumped
since this change; they did not before.

### Viewer-exact (variant B)
Activity bumps a photo **only** in the feed of the users who can see the
triggering album. Example: a comment in album Z (A is not a member) does
**not** bump the photo in A's feed, even if A sees the photo via album X.

Consequence: the sort value is **per (photo, viewer)** → it must be
**materialized** (fan-out), otherwise stable cursor pagination
is impossible. Reach of the events:

| Event | bumps for … |
|---|---|
| Photo added to album X | participants of X |
| Comment in album X (created/edited) | participants of X (`photo_comments.album_id`) |
| Description written | **all** who can see the photo (global – every viewer "sees" it) |
| Photo favorited | **all** who can see the photo |

### Likes = existing favorites (no new concept)
`photo_curation` (PK `(user_id, photo_id)`, status `visible|hidden|favorite`)
is already a per-user heart with aggregation and fan-out (`photo_favorited`).
The feed like **is** the favorite toggle:

| Feed card | Source |
|---|---|
| Heart filled? | own `photo_curation.status === 'favorite'` |
| Like count | `count(*) WHERE photo_id=? AND status='favorite'` |
| Heart click / double-tap | existing `POST /photos/:id/curation` (`favorite` ↔ `visible`) |

- **No new table, no new fan-out** — everything already exists.
- `hidden` stays untouched (a like only toggles `favorite ↔ visible`).
- XMP write-back only for the owner on their own photo (uncritical in the feed).
- A like **bumps the feed** (one of the four actions that bring a photo into
  the feed at all). Only when set, not when withdrawn — a
  change of mind should not wash anything back to the top.

## Data model

New materialized table (per-user index of the content feed):

```sql
CREATE TABLE photo_feed_entries (
  user_id          INTEGER     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  photo_id         INTEGER     NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  last_activity_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, photo_id)
);
CREATE INDEX idx_photo_feed_entries_timeline
  ON photo_feed_entries (user_id, last_activity_at DESC, photo_id DESC);
```

Reading (trivial, index-backed, cursor-stable):

```sql
SELECT photo_id, last_activity_at
FROM photo_feed_entries
WHERE user_id = :A
  AND (last_activity_at, photo_id) < (:cursorTs, :cursorId)   -- keyset cursor
ORDER BY last_activity_at DESC, photo_id DESC
LIMIT :limit;
```

## Fan-out / reconcile logic (the heart of variant B)

New module, hooked into the same mutation sites that call `emitFeed` today
for the notification feed.

**Bump (monotonic, only raise) — `GREATEST(existing, ts)`:**
- `bumpForAlbumParticipants(photoId, albumId, ts)` — add-to-album, comment
- `bumpForAllViewers(photoId, ts)` — metadata edit

**Reconcile (compare target viewer set, insert/delete):**
- `reconcilePhotoViewers(photoId)` — uses the existing `getUsersWithPhotoAccess()`;
  inserts missing entries, deletes orphaned ones.

**Maintenance matrix:**

| Mutation | Action |
|---|---|
| Photo added to album X | bump participants(X), initial `added_at` |
| Photo removed from album X | `reconcilePhotoViewers(photo)` (deletes whoever no longer sees it anywhere — stays) |
| Album X shared with user U | create entries for all photos in X for U (bump) |
| Share revoked / `album_left` | `reconcilePhotoViewers` for all photos in X |
| Description written | `onDescriptionWritten(photo)` (clearing does not bump) |
| Capture date corrected | **no** bump |
| Comment created/edited | `bumpForAlbumParticipants(photo, album_id, ts)` |
| Photo deleted | DB CASCADE |
| Album deleted | `reconcilePhotoViewers` for affected photos |
| Favorite set | `onFavorite(photo)` |
| Favorite withdrawn | **no** bump |

At family-archive scale (few participants per album) the fan-out is uncritical.

## Stages

### Stage 1 — Data layer
- Migration `photo_feed_entries` (+ index) under `db/migrations/postgres/`.
- **Maintain `db/migrations/postgres/meta/_journal.json`** (otherwise Drizzle skips the migration → CI red).
- Add Drizzle schema in `db/schema.ts`.
- **Backfill** for existing data: `last_activity_at = GREATEST(added_at, photos.updated_at, max(relevant comment))` per (user, photo).
- `npm run test` green → commit.

### Stage 2 — Fan-out/reconcile module
- New module (e.g. `feed/content-feed.service.ts`), bump/reconcile helpers.
- Hook into mutation sites in `photo/photo.service.ts` & `photo/reactions.service.ts` (next to the existing `emitFeed`).
- Tests for every maintenance row (add/remove/share/unshare/leave/metadata/comment).
- `npm run test` green → commit.

### Stage 3 — Read endpoint
- `GET /feed/photos` — keyset cursor `(last_activity_at, photo_id)`, limit/default as in the existing feed.
- Response per post: photo + thumbnail/URL, album context, like count + `likedByMe`, comment preview + count.
- Realtime event for live prepend (analogous to `feed/item.added`).
- Tests → commit.

### Stage 4 — Frontend
- New view (e.g. `FotoFeedView.vue`) + route + API client.
- Post cards: header (avatar/name/album), image filling the format, action bar (heart/comment), caption, comment preview.
- **Infinite scroll** via IntersectionObserver (no "load more" button).
- Heart = favorite toggle (`POST /photos/:id/curation`), double-tap gesture, optimistic update.
- Inline comments via the existing reactions API.
- Realtime prepend.
- Storybook story for the card; layout verification as far as possible.
- `npm run test` green → push.

## Decided points
- **Like count scope: global per photo** (`count(*)` of all `favorite` rows).
- **Separate menu item** for the content feed; the existing `/fotos/feed`
  (notifications) is kept unchanged.

## Open points
- Carousel for multi-image posts (`payload.photoIds`) — optional later stage.
