# Image metadata mapping

This document describes which EXIF, IPTC and XMP fields are read from image
files during upload and library import, and which columns they populate in
the `photos` table.

Parsing happens in `photo.service.ts` via the [`exifr`](https://github.com/MikeKovarik/exifr)
library with `{ gps: true, xmp: true, iptc: true }`. The `getExifMetadata()`
function returns a normalised `ExifMetadata` object; the import/refresh paths
then project a subset of it into the DB row.

## Parsed fields (`ExifMetadata`)

| Field         | Source priority (first non-empty wins)                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| `takenAt`     | EXIF `DateTimeOriginal` → EXIF `CreateDate` → IPTC `DateCreated` + `TimeCreated`    |
| `latitude`    | EXIF GPS                                                                            |
| `longitude`   | EXIF GPS                                                                            |
| `description` | EXIF `ImageDescription` → XMP `Description` / `dc:description` (x-default) → EXIF `UserComment` → IPTC `Caption-Abstract` |
| `keywords[]`  | IPTC `Keywords` → XMP `dc:subject` (single string with `;` or `,` is split)         |
| `author`      | IPTC `By-line` → EXIF `Artist` → XMP `dc:creator`                                   |
| `headline`    | IPTC `Headline` (stand-alone — no longer conflated with `title`)                    |
| `title`       | XMP `dc:title` (language-alternative resolved to `x-default` or first entry)        |
| `copyright`   | IPTC `CopyrightNotice` → EXIF `Copyright` → XMP `dc:rights`                         |
| `credit`      | IPTC `Credit`                                                                       |
| `city`        | IPTC `City`                                                                         |
| `state`       | IPTC `Province-State` → IPTC `State`                                                |
| `country`     | IPTC `Country-PrimaryLocationName` → IPTC `Country`                                 |

XMP language-alternative unwrapping (e.g. `dc:description`, `dc:title`) is
handled by the `asString()` helper: it prefers `x-default`, falling back to
the first locale entry.

IPTC `Keywords` may arrive as an array or as a single string containing
`;` / `,` separators; both shapes are normalised into `string[]`.

## Persisted columns (`photos` row)

The insert in `importFile` (`libraries.service.ts`) and the upload/refresh
paths in `photo.service.ts` write the following columns. Fields listed under
"Parsed" but **not** in this table are currently read but not persisted —
they are available in memory for auxiliary logic (e.g. IPTC location
derivation) but nothing stores them permanently.

| Column             | Source                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `taken_at`         | `ExifMetadata.takenAt`                                                                                  |
| `latitude`         | `ExifMetadata.latitude`                                                                                 |
| `longitude`        | `ExifMetadata.longitude`                                                                                |
| `description`      | `combineDescription(meta)` — see below                                                                  |
| `keywords[]`       | `ExifMetadata.keywords`                                                                                 |
| `location_city`    | `ExifMetadata.city` (only if any of `city`/`state`/`country` is set)                                    |
| `location_country` | `ExifMetadata.country`                                                                                  |
| `location_name`    | derived: `"<city \| state>, <country>"` (whichever components are present)                              |
| `location_short`   | `city ?? state`                                                                                         |

### `combineDescription()`

`photos.description` is built by the helper `combineDescription(meta)`:

1. Pick a **base**: `description ?? headline` (XMP/EXIF/IPTC caption, falling
   back to IPTC Headline).
2. If **XMP `dc:title`** is also present and is not already a substring of
   the base, append it after a blank line:

   ```
   <base>
   <blank line>
   <title>
   ```

3. If only one of base or title is set, that value is used verbatim.
4. If neither is set, the column stays `NULL` (or retains its prior value on
   refresh).

### Fields read but not stored

The following fields are returned by `getExifMetadata()` but currently have
no column in `photos`. They are effectively discarded after parsing:

- `author` — IPTC By-line / EXIF Artist / XMP dc:creator
- `copyright` — IPTC CopyrightNotice / EXIF Copyright / XMP dc:rights
- `credit` — IPTC Credit
- `state` — IPTC Province-State (used as a fallback when building
  `location_name` / `location_short`, but not stored as its own column)

Adding dedicated columns for these is a straightforward migration if they
are needed by a future feature; today's import simply drops them.

## Import modes and file bytes

Regardless of metadata handling, the raw image file is never re-encoded on
import:

- **`move` mode** — the file is relocated into `UPLOAD_DIR` via
  `fs.rename()`. Across filesystem boundaries (`EXDEV`) the scanner falls
  back to `fs.copyFile()` + `fs.unlink()`. In either case the bytes are
  preserved exactly; only the path changes. Derivative thumbnails are
  generated from this canonical copy.
- **`link` mode** — the file stays where it is. `photos.external_path`
  records the absolute source path; `photos.filename` holds a synthetic
  routing key `__library/<library-id>/<basename>` so the file-serving
  endpoint can read the bytes back from `external_path`.
- **HTTP upload** — the uploaded buffer is written to `UPLOAD_DIR` as-is
  (after an extension-normalisation step that only renames the target
  filename).

Thumbnail generation is a separate re-encoding step that reads the canonical
file and writes down-scaled variants to the thumbnail cache. The original
image bytes are never modified.
