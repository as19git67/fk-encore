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

### Rendering pipeline (hybrid: CSS-first)

Most display happens in the browser via CSS / SVG filters on the largest
cached thumbnail. `sharp` is only invoked where the bytes themselves must
contain the transformation (grid thumbnails, exports).

| Use case | Path |
| --- | --- |
| Detail view / Lightbox / Editor live-preview | Cached thumbnail + CSS/SVG filters from the recipe |
| Grid thumbnail | Server-rendered derivative (`sharp`) at the requested grid size, cached |
| Download / Share / Print / Export | Server-rendered one-shot (`sharp`), not cached |
| External consumers (iOS app, share-links for non-users) | Server-rendered |

Recipe → browser primitive mapping:

| Field | CSS / SVG | Notes |
| --- | --- | --- |
| `crop` | `transform: scale/translate` in an `overflow:hidden` wrapper, or `object-fit: cover` + `object-position` for aspect-locked containers | Original is still downloaded — fine for one-image views, prohibitive for grids |
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

## Phased rollout

1. **Migration** — `photo_transforms`, `photo_transform_suggestions`, plus
   journal entry.
2. **Suggestion compute** — `computePhotoTransformSuggestions(photoId)`
   chained behind the existing face/landmark hooks.
3. **Frontend display layer** — recipe → CSS/SVG filter helper, shared
   `<svg><defs>` block. Detail view + live-preview only.
4. **Server render path** — `sharp`-based `/photo/:id/render` for grid
   sizes; `/photo/:id/export` for downloads.
5. **Editor UI** — `vue-advanced-cropper` integration, sliders, 90°
   rotation buttons, Save / Discard.
6. **Adopt flow** — hint banner + one-click materialise.
7. **Optional follow-ups** — CLAHE, learned saliency, free-angle rotation.

## Open follow-ups for future phases

- Free-angle rotation (relax the `rotation` check constraint).
- CLAHE / Zero-DCE for difficult low-light shots if user feedback warrants.
- Learned saliency (U²-Net / BASNet) if heuristic crops feel off — only
  worth it if A/B feedback is clearly negative.
- Optional per-user "always apply suggestion" preference, currently off
  by design.

## Related docs

- [Auto-Crop: Intelligent Thumbnail Positioning](./auto-crop.md) — the
  focus-point precursor, still used for the square grid thumbnails.
- [Investigation log](./photos-ai-crop-investigation.md) — full design
  rationale, evaluated alternatives, resolved decisions.
