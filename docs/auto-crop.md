# Auto-Crop: Intelligent Thumbnail Positioning

> **See also:** [AI Photo Transformations](./photos-ai-transforms.md) — the
> upcoming feature that adds aspect-aware crop rectangles, exposure /
> contrast correction and per-user variants on top of the focus-point
> mechanism described here.

## Summary

Portrait-oriented images are displayed as square thumbnails in the grid.
By default, the browser crops the top and bottom evenly (centered).
With auto-crop, the visible section is shifted so that detected faces
or points of interest are in focus.

## How it works

### No server-side cropping

The original image and the generated thumbnail are **not** modified.
The thumbnail remains a normal, proportionally scaled JPEG (e.g. 400px wide).

The trick happens purely in **CSS**: the thumbnail is rendered in a 1:1 square
in the grid with `object-fit: cover`. `object-position` then determines
which section of the image is visible.

```
Without auto-crop (default):       With auto-crop (face on top):
object-position: 50% 50%           object-position: 50% 30%

┌─────────┐                        ┌─────────┐
│ xxxxxxx │ ← cropped              │  ( ^ ^) │ ← face visible
│         │                        │   \_/   │
│  ( ^ ^) │ ← face                 │ xxxxxxx │
│   \_/   │                        │ xxxxxxx │
│ xxxxxxx │ ← cropped              │ xxxxxxx │ ← cropped
└─────────┘                        └─────────┘
```

### Focus point calculation

The focus point is stored as normalized coordinates `{ x: 0..1, y: 0..1 }`
and computed according to the following priority:

1. **Faces** (priority): weighted centroid of all detected faces.
   Larger faces carry more weight so that the main face determines the crop.
2. **Landmarks** (fallback): if no faces are present, the landmark with the
   highest confidence is used (e.g. a building or a bridge).
3. **No crop**: if neither faces nor landmarks were detected, `auto_crop`
   stays empty and the browser uses the default centering (50% / 50%).

### Example

A portrait photo with a face in the upper third:

- Face bbox: `{ x: 0.3, y: 0.15, width: 0.4, height: 0.2 }`
- Computed focus: `{ x: 0.5, y: 0.25 }` (center of the bbox)
- CSS: `object-position: 50% 25%`
- Result: the visible section shifts upward to the face.

## Technical details

### Database

Column `auto_crop` (JSONB, nullable) on the `photos` table:

```json
{ "x": 0.5, "y": 0.25 }
```

Migration: `db/migrations/postgres/0010_auto_crop.sql`

### Backend

- **`computeAndStoreAutoCrop(userId, photoId)`** in `photo/photo.service.ts`
  - Reads all non-ignored faces and landmarks from the DB
  - Computes the weighted focus point
  - Stores the result in `photos.auto_crop`
- Called automatically at the end of `indexPhotoFaces()` and `indexPhotoLandmarks()`
- **Bulk endpoint**: `POST /photos/recompute-auto-crops` recomputes the focus
  point for all existing photos based on existing detection data

### Frontend

- `PhotoGrid.vue` reads `photo.auto_crop` and applies it as `imageStyle`:
  ```ts
  { objectPosition: `${auto_crop.x * 100}% ${auto_crop.y * 100}%` }
  ```
- `HeicImage.vue` applies the style to the `<img>` element (via `:style="imageStyle"`)
- Works in all grid views: photos, albums, search results

### Data management

In the data management view (DataManagementView) there is a button
**"Recompute auto-crop"** that recomputes the focus point for all photos
based on the existing face / landmark data.
This is needed once for photos that were uploaded before the feature was
introduced.
