# Photos: AI Crop & Transformation Suggestions — Investigation

Investigation phase for #90 / Epic #384 (Track S). No code changes; this
document captures the evaluation and proposed design so it can be reviewed
before implementation starts.

## 1. Status Quo

What already exists in the repo, and is therefore *not* what this feature
needs to build from scratch:

| Concern | State | Location |
| --- | --- | --- |
| Image processing | `sharp` (libvips) for thumbnails, EXIF-rotate, resize | `photo/photo.service.ts` |
| Original storage | Filesystem under `PHOTO_UPLOAD_DIR`, MD5-sharded | `photo/photo.service.ts` |
| Thumbnail cache | `PHOTO_THUMBNAIL_DIR`, also MD5-sharded | `photo/photo.service.ts` |
| Photo metadata | `photos` table with `width`, `height`, `auto_crop` (jsonb focus point) | migrations 0010, 0076 |
| Per-user state | `photo_curation`, `photo_description`, `photo_keywords` | migrations 0015, 0021 |
| Face detection | InsightFace `buffalo_l`, bboxes + embeddings in `faces` | `insightface-service/` |
| Landmark detection | Grounding DINO bboxes in `photo_landmarks` | `landmark-service/` |
| Focus-point compute | Weighted centroid faces → landmark fallback | `docs/auto-crop.md` |
| LLM service | Llama-3.2-3B + e5 multilingual, **text-only** | `llm-service/` |
| Frontend | Vue 3 + PrimeVue, no cropper library installed | `frontend/src/` |

Important nuance: the existing `auto_crop` is **only a CSS focus point**
(`object-position`) for centering a square thumbnail. It is *not* an
aspect-aware crop rectangle, and it is global per photo, not per user. This
investigation extends — it does not replace — that mechanism.

## 2. Model / Method Evaluation

The task description lists four candidate directions. The evaluation result
is to pick the cheapest method that satisfies the acceptance criteria,
because everything in this stack runs on CPU and the LLM service is already
the bottleneck.

### 2.1 Saliency for auto-crop

| Option | Effort | Runtime cost | Verdict |
| --- | --- | --- | --- |
| **Reuse existing faces + landmarks + rule-of-thirds heuristic** | low | ~ms in Node | ✅ Recommended |
| U²-Net / BASNet saliency map | medium | ~300–800 ms / image CPU, model ~170 MB | ⛔ Overkill — we already know where the subject is |
| MediaPipe Selfie-Segmentation | medium | fast on CPU but only people-centric | ⛔ Redundant with InsightFace bboxes |
| Grounding DINO general object detection (already running) | none | already paid | ✅ Use as fallback when no faces |

**Decision:** compute crop rectangles directly from the existing
`faces` and `photo_landmarks` data. For photos that have neither, fall back
to a center crop. Only invest in a learned saliency model if user feedback
on these heuristic crops is poor.

Heuristic (per requested aspect ratio):

1. Collect the convex hull of all non-ignored face bboxes (weighted by area).
2. If empty, use the highest-confidence landmark bbox.
3. Pad the hull by ~15 % on each side.
4. Snap the crop rectangle to the requested aspect ratio while keeping the
   hull fully inside and placing its centroid on the nearest rule-of-thirds
   intersection.
5. Clamp to image bounds.

For each photo we precompute *suggested crops* for the common ratios
(1:1, 4:5, 3:4, 4:3, 16:9). They are normalized (0..1) coordinates so they
survive resizing.

### 2.2 Exposure & contrast

| Option | Effort | Verdict |
| --- | --- | --- |
| `sharp.stats()` histogram → `normalize()` / `linear(a,b)` / `gamma()` | low | ✅ Recommended baseline |
| CLAHE via OpenCV/wasm-opencv | medium | optional, local contrast for backlit shots |
| Zero-DCE / LUTNet (learned) | high | not needed in phase 1 |

**Decision:** derive `exposure_ev`, `contrast`, `black_point`, `white_point`
from the channel-mean / stdev / percentile data returned by `sharp.stats()`
and the dominant histogram peak. Map to a `linear(multiplier, offset)` plus
`gamma()` recipe. CLAHE is parked as a follow-up if real photos demand it.

### 2.3 Inference location

`llm-service` is Python/CPU and currently text-only; pulling image models
into it would push it further from "small text helper" toward a
multi-purpose ML gateway. The image work proposed here is either:

- pure `sharp` math (Node, in the photo service), or
- reusing the existing `insightface-service` / `landmark-service` outputs.

**Decision:** keep computation in the `photo` service (Node + sharp). No
new model service in phase 1. Re-evaluate only if we add a learned
saliency or low-light model later.

## 3. Storage Concept

The two extremes in the task description (write back into the file vs. keep
a transformations list per (photo, user)) trade off rollback simplicity
against multi-user support. The acceptance criteria of #90 require **both**
rollback and per-user variants, which forces the non-destructive option.

### 3.1 Proposed model

```
photo_transforms                            (per user, per photo)
  id            bigserial pk
  photo_id      bigint   fk → photos.id     (cascade)
  user_id       bigint   fk → users.id
  source        text     'ai' | 'user' | 'adopted'
  adopted_from  bigint   nullable fk → photo_transforms.id
  crop          jsonb    { x, y, w, h }     -- normalized 0..1, nullable
  rotation      smallint default 0          -- 0/90/180/270 (+free angle later)
  exposure      real     default 0          -- EV, e.g. -2..+2
  contrast      real     default 0          -- -1..+1
  gamma         real     default 1
  white_point   real     nullable
  black_point   real     nullable
  applied_at    timestamptz nullable        -- null = suggestion only
  created_at    timestamptz default now()
  updated_at    timestamptz default now()
  unique (photo_id, user_id)                -- one active record per user

photo_transform_suggestions                 (global, per photo)
  photo_id      bigint pk fk → photos.id
  payload       jsonb                       -- {crops: {"1:1":…, "4:5":…}, exposure:…, contrast:…}
  model_version text
  computed_at   timestamptz
```

Rationale:

- **Original file is never overwritten.** Sharp re-renders the requested
  output from the original on every request. The thumbnail directory is
  the cache.
- **Per-user variant:** `photo_transforms (photo_id, user_id)` row holds
  the user's chosen recipe. Absent row = original, no transform applied.
- **Rollback** = delete the row (or null its fields). One DELETE.
- **Adopt** = `INSERT … SELECT … FROM photo_transforms WHERE photo_id=$1
  AND user_id=$other`, with `source='adopted'` and `adopted_from` set.
- **Suggestions** live in a separate global table because they are computed
  once per photo (not per user), refreshed only when face/landmark data
  changes. This keeps the per-user table small.

### 3.2 Rendering pipeline

Derivative URL: `GET /photo/:id/render?w=1600&v=user|original|suggested`.

1. Resolve the recipe (user transform → suggestion → original).
2. Compute a deterministic cache key
   (`md5(photo_hash + recipe_json + width)`).
3. If cached on disk under the existing sharded thumbnail tree → stream.
4. Otherwise: `sharp(original)` →
   `.extract(crop_in_pixels)` → `.rotate()` →
   `.linear(a,b).gamma()` → `.resize(w)` → write cache → stream.

Cache invalidation: on `photo_transforms` UPDATE/DELETE we issue a
"delete files with prefix `<photoHash>:<userId>:`" job — same shard, same
filesystem, no new infra.

### 3.3 Why not bake into the original

- Multi-user support is in the acceptance criteria. Re-encoding loses data.
- Re-encoding JPEGs accumulates generational loss; HEIC re-encode is slow
  on CPU.
- Rolling back would require keeping a pre-edit backup anyway, which is
  effectively the same disk cost as just keeping the recipe.
- The existing thumbnail cache already proves that on-demand rendering at
  this scale is acceptable.

## 4. Acceptance Criteria Mapping (#90)

| Criterion | How the design satisfies it |
| --- | --- |
| AI suggestions clearly visible | `photo_transform_suggestions` is rendered as an overlay/preview in the photo detail view. Frontend shows a "Suggested crop" thumbnail next to the original. |
| Sofort anwendbar / editierbar | "Apply" creates a `photo_transforms` row from the suggestion. "Edit" opens the crop editor with the suggestion pre-filled. |
| Rollback & user-specific storage | DELETE on `photo_transforms` row = full rollback to original. Per-user row guarantees isolation. |
| Adopt mechanism | List endpoint returns other users' transforms for the same photo; one-click insert copies them. |

## 5. Frontend Notes

- No cropper library is currently installed. Recommended:
  `vue-advanced-cropper` (lightweight, MIT, supports aspect locking and
  passing in an initial crop rectangle — perfect for "open editor with AI
  pre-set").
- Sliders for exposure / contrast / gamma via PrimeVue `Slider`.
- Preview pipeline: while editing, do **not** re-fetch from server on every
  slider tick. Apply CSS `filter: brightness() contrast()` and a CSS
  `clip-path` for the crop, then commit the final recipe to the server on
  save. This is already standard practice for non-destructive editors.

## 6. Conflict / Coordination

- **DB schema:** adds two new tables, no changes to existing tables. Low
  conflict risk, but coordinate migration index with other open tracks
  before assigning numbers (next free after `0079`).
- **`llm-service`:** **not touched** in phase 1.
- **Existing `auto_crop` focus point:** stays as-is. The new suggestions
  table is additive; the CSS focus-point behaviour for grid thumbnails
  keeps working unchanged.
- **`insightface-service` / `landmark-service`:** no new dependency, only
  consumers of their existing outputs.

## 7. Phased Implementation Sketch (post-investigation)

1. **DB migration**: `photo_transforms`, `photo_transform_suggestions`,
   plus journal entry.
2. **Service**: `computePhotoTransformSuggestions(photoId)` triggered from
   the same hook that already calls `computeAndStoreAutoCrop` (i.e. after
   face/landmark indexing). Sharp-based render endpoint.
3. **Editor UI**: integrate `vue-advanced-cropper`, sliders, save/discard.
4. **Adopt flow**: list other users' transforms, copy on click.
5. **(Optional, later)** CLAHE / learned saliency if user feedback warrants.

## 8. Open Questions for the Maintainer

1. Should the AI suggestion be auto-applied for new photos of a user who
   has opted in, or always require explicit "Apply" / "Edit"?
2. Aspect ratios to precompute: confirm 1:1, 4:5, 3:4, 4:3, 16:9 are the
   right set (driven by gallery / share / print needs)?
3. Adopt-by-default: when a user opens a photo that has no own transform
   but another user has one, do we show theirs as a hint, or stay silent
   until they explicitly browse "other versions"?
4. Free-angle rotation in phase 1, or 90° steps only?

Decisions on these gate the implementation phase.
