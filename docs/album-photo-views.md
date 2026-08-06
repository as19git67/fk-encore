# Album Photo Views – Feature Documentation

## Background and motivation

Shared photo albums have a recurring problem: multiple people contribute
photos, but opinions diverge when it comes to culling. One participant would
delete a photo, another wouldn't. Even after culling, there are often still
too many photos to quickly show the highlights of an event.

### Core problems

1. **Disagreement when culling** – there is no objective "right" cut for an album.
2. **Too many photos after culling** – 200+ photos are still too many for a
   quick presentation.
3. **No visibility into other participants' opinions** – you don't know what
   the others consider good or bad.

## Solution: views with anonymized opinions

Instead of having to agree on *one* cut, every participant sees *their* version
of the album. The opinions of the others are visible as anonymized counters
("3 out of 5 like it") without revealing who decided what.

### Design decisions

- **Anonymized instead of named**: social dynamics are avoided. You see
  "2 out of 4 have hidden it", not "Max hid your photo".
- **Preset-based instead of complex**: 3 predefined views cover 90% of the
  use cases.
- **Progressive complexity**: the base mechanics (hide/favorite) already
  existed. Views are a new lens over existing data.
- **AI as a third voice**: the AI quality score provides a neutral, technical
  assessment alongside the human opinions.

## Architecture

### Data model

The feature is built entirely on top of existing tables:

- **`photo_curation`** (existing): stores the per-user+photo status
  (`visible` | `hidden` | `favorite`).
- **`album_user_settings`** (extended): `active_view` extended with new
  values, `view_config` JSONB now typed.

No new tables required.

### New types

```typescript
type ActiveView = "all" | "favorites" | "consensus" | "custom";

interface ViewConfig {
  hideFilter: "none" | "mine" | "consensus";
  hideConsensusMin?: number;
  favFilter: "all" | "mine" | "any" | "consensus";
  favConsensusMin?: number;
}

interface PhotoCurationStats {
  fav_count: number;    // how many album participants favorited
  hide_count: number;   // how many have hidden
  member_count: number; // total number of participants
}
```

### View presets

| Preset | hideFilter | favFilter | Description |
|---|---|---|---|
| **All photos** | `mine` | `all` | Default – everything except the ones I hid |
| **My favorites** | `mine` | `mine` | Only what I favorited |
| **Group highlights** | `consensus` (min 1) | `consensus` (min 2) | What at least 2 people like and nobody hid |

### Query logic

The album photo query aggregates curation data across all participants:

```sql
SELECT p.*, my_pc.status AS curation_status,
  SUM(CASE WHEN all_pc.status = 'favorite' THEN 1 ELSE 0 END) AS fav_count,
  SUM(CASE WHEN all_pc.status = 'hidden' THEN 1 ELSE 0 END) AS hide_count
FROM photos p
INNER JOIN album_photos ap ON ap.photo_id = p.id
LEFT JOIN photo_curation my_pc ON my_pc.photo_id = p.id AND my_pc.user_id = :userId
LEFT JOIN photo_curation all_pc ON all_pc.photo_id = p.id
  AND all_pc.user_id = ANY(:participantIds)
GROUP BY p.id, my_pc.status
```

Filters are applied in JavaScript (instead of dynamic HAVING clauses), since
the number of photos per album is typically manageable and the code stays
significantly more readable.

### Performance

- New index: `idx_photo_curation_photo_status` on
  `photo_curation(photo_id, status)` for fast aggregation.
- Participant IDs are fetched once and passed in an array instead of a
  subquery per photo.

## Frontend integration

### View selection

The previous two separate SelectButtons (view + hide) have been replaced by a
single view selector with presets. The "Group highlights" button only appears
for shared albums.

### Anonymized badges in the photo grid

Every photo in shared albums shows small badges:
- Heart icon with counter (e.g. "3/5") – favorites counter.
- Eye icon with counter (e.g. "1/5") – hide counter (only if > 0).

### Opinions block in the detail sidebar

When a photo in a shared album is selected, the sidebar shows an "Opinions"
block with:
- Progress bar for favorites share.
- Progress bar for hide share (only if > 0).
- AI rating as a third row (when available).

## Virtual AI participant

The AI acts as a virtual album participant that automatically votes based on
the quality score.

### How it works

1. **System user**: a special user `AI-Rating` (email: `ai@system.local`) is
   created during seeding. This user cannot log in (invalid password hash).

2. **Automatic voting**: after every quality scoring, the AI writes a
   `photo_curation` entry:
   - score >= 0.7 (configurable via `AI_FAV_THRESHOLD`) -> `favorite`
   - score <= 0.3 (configurable via `AI_HIDE_THRESHOLD`) -> `hidden`
   - in between -> `visible`

3. **Participant counting**: the AI user is counted as an additional
   participant in every album. Its vote flows into `fav_count` and
   `hide_count`.

### Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `AI_FAV_THRESHOLD` | `0.7` | Score at which the AI votes "favorite" |
| `AI_HIDE_THRESHOLD` | `0.3` | Score below which the AI votes "hide" |

### Impact on views

- **All photos**: the AI vote is visible in the counter (e.g. "2/4" instead
  of "1/3").
- **Group highlights**: an AI favorite counts as a vote for consensus.
- The AI vote is **anonymized** like all others – not recognizable as "AI"
  in the frontend, simply another participant.

## Affected files

### Backend
- `db/types.ts` – new types (ViewConfig, ActiveView, PhotoCurationStats)
- `db/seed.ts` – create the "AI-Rating" system user
- `db/schema.ts` – unchanged (JSONB `view_config` carries the new types)
- `db/migrations/postgres/0010_album_curation_views.sql` – performance index
- `photo/photo.service.ts` – aggregated query, preset mapping, filter logic,
  AI curation

### Frontend
- `frontend/src/api/photos.ts` – new types (AlbumPhoto, ViewConfig,
  PhotoCurationStats)
- `frontend/src/views/AlbumDetailView.vue` – unified view selector
- `frontend/src/components/PhotoGrid.vue` – curation stats badges
- `frontend/src/components/PhotoDetailSidebar.vue` – opinions block with
  progress bars

### iOS (issue #760)
- `ios/Sources/FKPhotos/Features/Albums/AlbumViewMode.swift` – the presets as
  pure, testable filter logic plus per-album persistence
- `ios/Sources/FKPhotos/Features/Albums/AlbumConsensusViews.swift` – "3/5"
  badges, the opinions block and the custom-threshold sheet
- `ios/Sources/FKPhotos/Features/Albums/AlbumDetailView.swift` – view picker,
  badge overlay, favorite voting from the grid
- `ios/Sources/FKPhotos/Features/Photos/PhotoFullscreenView.swift` –
  "Meinungen" section in the detail panel
- `ios/Sources/FKPhotos/Core/Models/Models.swift` – `PhotoCurationStats`
  extended to all three counters, `AlbumPhotoRow` wire type
- `ios/Tests/FKPhotosTests/AlbumViewModeTests.swift` – locks the filter
  semantics against `VIEW_PRESETS`

**Why iOS filters on the device.** The web stopped using the server-side
presets: `AlbumDetailView.vue` resets `active_view` to `"all"` on every load
and narrows the full album client-side. An `active_view` persisted from iOS
would therefore be undone the next time the album is opened in a browser, so
the app keeps its lens local instead of racing the web for that setting.

One consequence is worth knowing: because the server still applies its default
`hideFilter: "mine"`, photos the current user hid never reach the device. In
`consensus` the server-side preset would instead keep them and judge purely by
`hide_count`. In practice that only omits photos you personally rejected, which
matches what every other view does — accepted rather than worked around.

## Possible extensions (future)

1. ~~**Custom view dialog**: when "Custom" is selected, a panel with sliders
   for the consensus thresholds.~~ Implemented on iOS (`AlbumViewConfigSheet`,
   steppers for "min favorites" / "max hides"); still open on the web.
2. **Saved / named views**: multiple views per user per album
   ("Photobook selection", "For grandma").
3. **Shared views**: a user creates a view and shares it with others.
4. **View as export basis**: "Export this view as ZIP".
5. **Automatic AI views**: "Top 20% by AI quality".
