# AI Photo Transformations: Crop, Exposure & Contrast

> **Status:** Designed, not yet implemented. The design rationale lives in
> [`photos-ai-crop-investigation.md`](./photos-ai-crop-investigation.md);
> this document is the user-/developer-facing feature reference and will
> grow into the canonical "how it works" doc as the feature is built out.

## Summary

For every photo the system computes non-destructive transformation
suggestions — aspect-aware crops, an exposure correction, and a contrast
correction. Users can either **apply** a suggestion as-is, **edit** it in
a cropper UI, or **adopt** another user's variant for the same photo.
The original file is never modified.

Differs from [Auto-Crop](./auto-crop.md): auto-crop only stores a single
*focus point* used for centering square grid thumbnails. The new system
adds true aspect-aware crop rectangles, exposure/contrast correction, and
per-user variants.

## User experience

| Action | What happens |
| --- | --- |
| Open a photo | Detail view shows the original. If an AI suggestion exists, a small "Vorschlag" thumbnail is shown next to it. If another user has a transformation but the current user does not, that variant is shown as a passive "Variante von <username>" hint. |
| Apply | The AI suggestion is materialised into a `photo_transforms` row for the current user. The detail view immediately reflects the change. |
| Edit | The cropper opens with the AI suggestion pre-filled. The user can adjust the crop rectangle, rotate in 90°-steps, and tweak exposure / contrast / gamma via sliders. Live preview is CSS-only — no server round-trip per slider tick. |
| Adopt foreign variant | One click copies another user's recipe into the current user's `photo_transforms` row. `source='adopted'`, `adopted_from` references the source row. |
| Reset | A single DELETE on the user's `photo_transforms` row reverts to the original. |
| Suggestions | AI suggestions are **never** auto-applied. The user always confirms via Apply or Edit-then-Save. |

## How it works

### Suggestion compute

After face/landmark indexing finishes for a photo (same hook that already
drives [auto-crop](./auto-crop.md)), `computePhotoTransformSuggestions()`
runs once per photo:

1. **Subject hull** — convex hull of all non-ignored face bboxes,
   area-weighted. Fallback: highest-confidence landmark bbox.
2. **Padding** — hull is expanded by ~15 % on each side to leave breathing
   room.
3. **Aspect snap** — for each target ratio the hull is snapped to a
   crop rectangle that keeps the hull fully inside and places its centroid
   on the nearest rule-of-thirds intersection.
4. **Both orientations** — ratios are tried in landscape *and* portrait;
   either or both can survive depending on whether the subject still fits.
5. **Exposure / contrast** — `sharp.stats()` returns per-channel mean,
   stdev and percentiles. From those we derive `exposure_ev`, `contrast`,
   `black_point`, `white_point` and `gamma`.

Target ratios (both orientations each): **1:1, 4:5, 5:4, 3:4, 4:3, 16:9,
9:16**.

Photos with neither faces nor landmarks fall back to a centered crop
matching the requested aspect ratio.

### Storage

Two new tables. The original file on disk is never overwritten.

```sql
-- Global per photo: precomputed suggestion payload.
CREATE TABLE photo_transform_suggestions (
  photo_id      BIGINT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  payload       JSONB NOT NULL,        -- {crops: {"1:1":…, …}, exposure, contrast, …}
  model_version TEXT NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per (photo, user): the user's active recipe. Absent = original.
CREATE TABLE photo_transforms (
  id           BIGSERIAL PRIMARY KEY,
  photo_id     BIGINT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  source       TEXT   NOT NULL CHECK (source IN ('ai','user','adopted')),
  adopted_from BIGINT REFERENCES photo_transforms(id) ON DELETE SET NULL,
  crop         JSONB,                  -- { x, y, w, h } normalised 0..1
  rotation     SMALLINT NOT NULL DEFAULT 0 CHECK (rotation IN (0,90,180,270)),
  exposure     REAL     NOT NULL DEFAULT 0,
  contrast     REAL     NOT NULL DEFAULT 0,
  gamma        REAL     NOT NULL DEFAULT 1,
  white_point  REAL,
  black_point  REAL,
  applied_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (photo_id, user_id)
);
```

Rationale:

- **No re-encoding** — the original JPEG/HEIC stays bit-identical.
- **Rollback** is a single `DELETE`.
- **Adopt** is `INSERT … SELECT … FROM photo_transforms WHERE user_id=$other`
  with `source='adopted'` and `adopted_from` set.
- **Suggestions** are global (one row per photo) because computing them is
  expensive but doesn't depend on the viewing user.

### Rendering pipeline (hybrid: server-rendered where it counts)

The original spec called for a CSS-first approach where the browser
applied the recipe to a cached original thumbnail. That worked for the
**colour** part of the recipe (exposure / contrast / gamma / BP / WP)
but the **crop** is awkward: the existing `HeicImage` component
already owns the layout and pulling crop math through it without
breaking the face-box-overlay slot is invasive. In practice the
shipped implementation routes recipe-aware surfaces through the
server-rendered `/photos/:id/render?v=user&user=<id>&w=<width>`
endpoint instead — the JPEG that comes back already has crop +
colour baked in, and the same disk-sharded thumbnail cache absorbs
the cost on every miss-but-once.

| Use case | Path |
| --- | --- |
| Editor live-preview (slider drag) | CSS / SVG filter on the original, cropped client-side via the editor's own cropper component |
| Detail-Sidebar, Fullscreen, gallery grid, album covers, recap, compare view | Server-rendered URL when the calling user has a recipe; bare `/photos/file/<filename>` otherwise |
| Download / Share / Print / Export | Server-rendered one-shot via `/photos/:id/export`, not cached |
| External consumers (iOS app, share-links for non-users) | Server-rendered |

The browser → server decision is made tile-by-tile via the
`useTransformedPhotosIndex` composable: one `GET /photos/transforms/mine`
lookup at app boot returns the set of `photo_id`s on which the calling
user has a transform, and the helper `photoThumbnailSrc(...)` picks
the URL accordingly. The set is also patched in-place from the
editor's save / delete / adopt / materialize handlers, so newly-edited
tiles flip to the rendered URL without a refetch.

Recipe → browser primitive mapping (used inside the editor preview
only):

| Field | CSS / SVG | Notes |
| --- | --- | --- |
| `crop` | `transform: scale/translate` in an `overflow:hidden` wrapper inside the cropper component | Only inside the editor — every other surface uses the server-rendered URL |
| `rotation` (90° steps) | `transform: rotate()` | |
| `exposure` (EV) | `filter: brightness(2^EV)` | sRGB-gamma vs. linear-light not identical; visually close |
| `contrast` | `filter: contrast()` | Direct match |
| `gamma` | SVG `feComponentTransfer type="gamma"` via `filter: url(#…)` | One shared `<defs>` block per page |
| `black_point` / `white_point` | SVG `feComponentTransfer type="linear"` (slope / intercept) | Same shared filter mechanism |

Server pipeline (when actually invoked):

1. Resolve the recipe (user transform → suggestion → original).
2. Compute a deterministic cache key
   `md5(photo_hash + recipe_json + width)`.
3. If cached on disk under the existing sharded thumbnail tree → stream.
4. Otherwise: `sharp(original) → .extract(crop) → .rotate() →
   .linear(a,b).gamma() → .resize(w)` → write cache → stream.

Cache invalidation: on any UPDATE/DELETE of `photo_transforms` we delete
all files matching `<photoHash>:<userId>:*` in the sharded thumbnail
tree. Same shard, same filesystem, no new infrastructure.

### Adopt flow

1. The detail view requests `GET /photo/:id/transforms` which returns the
   current user's transform (if any) plus a list of other users'
   transforms with `username` and a small preview thumbnail URL.
2. If the user has none and at least one foreign transform exists, a hint
   banner appears.
3. Clicking "Übernehmen" calls `POST /photo/:id/transforms/adopt`
   `{ from: <transform_id> }`, which `INSERT … SELECT`s the recipe with
   `source='adopted'` and `adopted_from` set.
4. The user can then `Edit` it like their own.

## Phased rollout — shipped

All seven planned phases have landed:

1. **Migration** — `photo_transforms`, `photo_transform_suggestions`,
   plus journal entry (`0085_photo_transforms`).
2. **Suggestion compute** — `computePhotoTransformSuggestions(photoId)`
   chained behind the existing face/landmark indexing hooks.
3. **Frontend display layer** — recipe → CSS/SVG filter helper for
   the editor's live preview (`utils/photoTransformRecipe.ts`).
4. **Server render path** — `sharp`-based `/photos/:id/render` and
   `/photos/:id/export`, plus the per-photo and bulk auto-levels
   helpers. HEIC paths route through `convertHeicToJpeg` because
   the bundled `libvips` can't decode HEIC directly.
5. **Editor UI** — `PhotoTransformEditor.vue` with the in-house
   `PhotoCropper.vue` (drag handles, ROT overlay, keyboard
   shortcuts), sliders for exposure / contrast / gamma / BP / WP,
   90° rotation buttons, Auto-Levels, Before/After hold-toggle.
   Triggers live in both `PhotoDetailSidebar` (desktop) and
   `FullscreenOverlay` (mobile).
6. **Adopt flow** — bundle response includes other users' recipes;
   one click on a chip in the editor materialises via
   `POST /photos/:id/transforms/adopt`.
7. **Display wiring** — `useTransformedPhotosIndex` composable
   provides a one-shot bulk index (`GET /photos/transforms/mine`)
   plus a tile-level helper that picks the server-rendered URL for
   photos the caller has edited. Wired into the gallery grid,
   album cover grid, recap player, compare view, fullscreen
   prev/next prefetch, and the detail sidebar.

## Endpoint summary

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `GET /photos/:id/transforms` | `photos.view` | Bundle: own row + other users' rows + suggestion |
| `PUT /photos/:id/transforms` | `photos.view` | Upsert own recipe |
| `DELETE /photos/:id/transforms` | `photos.view` | Delete own recipe (idempotent) |
| `POST /photos/:id/transforms/from-suggestion` | `photos.view` | Materialize AI suggestion for chosen ratio |
| `POST /photos/:id/transforms/adopt` | `photos.view` | Copy another user's recipe |
| `POST /photos/:id/transforms/auto-levels` | `photos.view` | Compute exposure/contrast/gamma for a crop region; returns recipe, does not persist |
| `GET /photos/transforms/mine` | `photos.view` | Set of photo IDs the caller has a transform on (gallery routing) |
| `GET /photos/:id/render?v=…` | none (parity with `/photos/file/*`) | Render with a recipe applied; cached by recipe content + width |
| `GET /photos/:id/export?v=…` | none | Full-resolution rendered JPEG with `Content-Disposition: attachment`; no cache |
| `POST /photos/recompute-transform-suggestions` | `data.manage` | Bulk recompute suggestions over all photos (skip-existing by default; `force` overrides) |

## Open follow-ups

- Free-angle rotation (relax the `rotation` check constraint).
- CLAHE / Zero-DCE for difficult low-light shots if user feedback warrants.
- Learned saliency (U²-Net / BASNet) if heuristic crops feel off — only
  worth it if A/B feedback is clearly negative.
- Optional per-user "always apply suggestion" preference, currently off
  by design.
- `PersonsGrid` and `FacePhotoGrid` intentionally stay on the
  original photo — those tiles render face-area zooms via
  `cover_bbox` + CSS transform, where applying the user's whole-
  photo crop would put the bbox into the wrong coordinate system.

## Related docs

- [Auto-Crop: Intelligent Thumbnail Positioning](./auto-crop.md) — the
  focus-point precursor, still used for the square grid thumbnails.
- [Investigation log](./photos-ai-crop-investigation.md) — full design
  rationale, evaluated alternatives, resolved decisions.
