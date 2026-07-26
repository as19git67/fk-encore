# OCR Improvements for Scanned PDFs

> Addresses [#892](https://github.com/as19git67/fk-encore/issues/892):
> gray-paper scans OCR poorly, and 90°-rotated scans cannot be recognized
> at all. This note documents the improvements made to the documents OCR
> pipeline and the `sane-scan-pdf` investigation the issue asked for.

## Summary

The documents pipeline extracts text from a scanned PDF by rasterizing each
page with `pdftoppm` and running `tesseract` (deu+eng) over the PNGs (see
[`documents/text-extract.ts`](../documents/text-extract.ts)). Two classes of
real-world scan defeated that pipeline:

1. **Grayish paper / weak lighting.** Scans on gray or off-white stock carry
   a mid-gray background cast. The low foreground/background contrast makes
   Tesseract drop thin strokes and light print.
2. **90°/180°/270° misrotation.** A landscape document auto-fed portrait (or
   a page laid sideways on the flatbed) reaches Tesseract rotated. Under the
   default `--psm 3`, Tesseract does **not** auto-rotate, so a sideways page
   recognizes as garbage — or nothing.

Both are now handled by a preprocessing step,
[`documents/ocr-preprocess.ts`](../documents/ocr-preprocess.ts), inserted
between rasterization and recognition. Every page image is:

1. **Auto-rotated to upright** — Tesseract's Orientation & Script Detection
   (`--psm 0`, the `osd` model) reports the rotation; `sharp` applies a
   lossless 90°/180°/270° rotation when the confidence clears a threshold.
2. **Contrast-cleaned** — `sharp` converts to grayscale, percentile-clip
   normalizes (pushing the gray cast up to white), and applies a gentle
   linear contrast stretch, so the page reaches Tesseract as clean
   black-on-white.

Because the searchable ("sandwich") PDF is built from these cleaned, upright
page images, **the served/downloaded PDF keeps the corrected rotation** — the
reader no longer has to tilt their head, and the on-page text layer lines up.
The stored original bytes are never modified (document bytes are immutable
per id; the sha256 digest is the dedup key), so the rotation lives in the
derived `_ocr` sidecar only, exactly like the existing OCR text layer.

Everything is **best-effort**: a missing `osd` model, a low-confidence
detection, or a `sharp` decode error leaves the untouched page image in
place, so OCR never regresses below the previous behavior.

## Runtime requirement: `tesseract-ocr-osd`

Orientation detection needs the `osd.traineddata` model. The runtime image
installs Tesseract with `--no-install-recommends`, which does **not** pull it
in, so [`docker/Dockerfile.runtime`](../docker/Dockerfile.runtime) now
installs `tesseract-ocr-osd` explicitly. Without it, `--psm 0` fails and the
pipeline simply skips rotation (contrast cleanup still runs).

## Tuning (environment variables)

All preprocessing is configurable; the defaults are conservative and aimed at
German/English office documents. Set `DOCUMENTS_OCR_PREPROCESS=0` to restore
the exact pre-#892 behavior.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOCUMENTS_OCR_PREPROCESS` | `1` | Master switch for the whole step (rotate + contrast). |
| `DOCUMENTS_OCR_AUTOROTATE` | `1` | Detect & correct 90°/180°/270° rotation via OSD. |
| `DOCUMENTS_OCR_ROTATE_MIN_CONFIDENCE` | `1.0` | Minimum OSD orientation confidence before rotating. |
| `DOCUMENTS_OCR_GRAYSCALE` | `1` | Convert the page to grayscale before contrast work. |
| `DOCUMENTS_OCR_NORMALIZE` | `1` | Percentile-clip normalization (lifts the gray cast to white). |
| `DOCUMENTS_OCR_NORMALIZE_LOWER` | `2` | Lower clip percentile. |
| `DOCUMENTS_OCR_NORMALIZE_UPPER` | `98` | Upper clip percentile. |
| `DOCUMENTS_OCR_CONTRAST` | `1.15` | Linear contrast multiplier around mid-gray (`1.0` = off). |
| `DOCUMENTS_OCR_THRESHOLD` | `0` | Optional hard binarization threshold (`0` = off). |

`DOCUMENTS_OCR_THRESHOLD` is off by default because a **global** threshold
destroys faint print. It is a per-deployment escape hatch for collections of
uniformly washed-out scans; the soft normalize+contrast path is enough for
the common case and preserves anti-aliased edges Tesseract's own (local) Otsu
binarizer prefers.

## Investigation: `sane-scan-pdf`

The issue asked us to learn from the Linux
[`sane-scan-pdf`](https://github.com/rocketraman/sane-scan-pdf) tool, which
produces notably clean scanned PDFs. It is a Bash wrapper that chains
single-purpose tools; the relevant stages and what we took from each:

| `sane-scan-pdf` stage | Tool | What it does | Our equivalent |
| --- | --- | --- | --- |
| Acquire | `scanimage` | Pulls frames from the SANE backend | N/A — we start from an already-scanned PDF, not a live scanner. |
| Deskew + clean | `unpaper` | Small-angle deskew, border/gutter cleanup, noise removal | **Partially adopted.** We do the high-value part (upright + contrast) with `sharp`; fine (<5°) deskew is deferred (see below). |
| Lighting/contrast | ImageMagick `convert` (`-level`, `-threshold`, `-normalize`) | Normalize lighting, drive background to white | **Adopted** via `sharp` (`grayscale` + `normalise` + `linear`, optional `threshold`) — no ImageMagick dependency needed. |
| Auto-rotate | `unpaper` / Tesseract OSD | Detect page orientation | **Adopted** via Tesseract OSD (`--psm 0`) — the same detector, already in the image. |
| Assemble | `pdfunite` / `img2pdf` | Merge pages into one PDF | Already done — Tesseract emits per-page searchable PDFs, `pdfunite` merges them. |

Key takeaways applied here:

- **Do the geometry and lighting fixes on the raster before OCR, not after.**
  This is exactly what `sane-scan-pdf` does with `unpaper`/`convert`, and it
  is where most of the OCR-quality win comes from.
- **Reuse the detector you already have.** `sane-scan-pdf` shells out to a
  pile of binaries; we get the same orientation signal from the Tesseract
  that is already in the runtime image, and the same contrast work from the
  `sharp` already used across the photo pipeline — no new system packages
  beyond the tiny `osd` data file.

### Deliberately not adopted (yet)

- **Fine-angle deskew (<5°).** `unpaper` rotates the page by a fraction of a
  degree to straighten scanner skew. Tesseract already deskews *internally*
  for recognition, so the text-quality benefit is small; the only visible win
  would be a straighter sandwich-PDF image. Doing it well needs a
  Hough/projection-profile angle estimate (OpenCV territory, like the
  `receipt-ocr-service`), which is more than this pipeline warrants today. If
  we revisit, the natural home is another `sharp.rotate(fineAngle, { background })`
  applied in the same preprocessing pass.
- **Border/gutter cleanup and hole-punch removal.** `unpaper` erases dark
  scan margins. These rarely hurt Tesseract and can eat real content when
  mis-tuned, so they are out of scope.
- **Adding ImageMagick / `unpaper` to the image.** Everything needed is
  already available through `sharp` + `tesseract`, so no new apt packages are
  pulled in (only the small `osd` data file).

## Follow-up: recovering isolated document-number markers

While testing the above against real scans, a third, previously-unreported
failure turned up: the household's own `#1234`-style document-number marker
(a printed sticker or stamp added before scanning; see
`extractDocumentNumber` in
[`documents/metadata-extract.ts`](../documents/metadata-extract.ts))
sometimes went missing from the OCR text entirely, on otherwise
clean, unrotated, high-contrast scans — i.e. independent of the two problems
fixed above.

**Root cause, confirmed against two real production scans:** in both cases
the marker was printed cleanly and legibly, but sat isolated in a page
corner right next to a graphic — a company logo in one case, a decorative
rounded box in the other. Tesseract's default page segmentation (`--psm 3`)
regularly fuses such an isolated corner block into the neighboring graphic
and drops it as a non-text region, even though the very same crop, run in
isolation, OCRs perfectly. Re-running the *same, full, uncropped* page with
`--psm 11` ("sparse text": find as much text as possible without assuming a
normal paragraph layout) recovered the marker correctly in both cases —
proof that this is a segmentation gap, not a recognition-quality problem
(so the preprocessing above does not help here).

**Fix:** `ocrPdf` in `text-extract.ts` now runs one extra `--psm 11` pass
over page 1 — but only when the primary `--psm 3` text has no `#1234`-style
marker at all (`shouldRunNumberMarkerFallback`, unit-tested). If the sparse
pass finds one, it's prepended to the extracted text so the existing
`extractDocumentNumber` regex picks it up exactly as if the primary pass had
found it. Because the fallback only fires when the marker is already
missing, the extra Tesseract call is rare in practice and cannot make a
working case worse. Toggle with `DOCUMENTS_OCR_NUMBER_FALLBACK=0`.

## Files

- [`documents/ocr-preprocess.ts`](../documents/ocr-preprocess.ts) — the
  preprocessing module (OSD parsing, rotation decision, `sharp` pipeline).
- [`documents/text-extract.ts`](../documents/text-extract.ts) — calls
  `detectOcrRotation` + `preprocessOcrImage` per page inside `ocrPdf`, and
  runs the sparse-text document-number fallback after the main OCR loop.
- [`documents/ocr-preprocess.test.ts`](../documents/ocr-preprocess.test.ts) —
  unit tests for the pure OSD-parsing and rotation-decision helpers.
- [`documents/documents.test.ts`](../documents/documents.test.ts) — includes
  unit tests for `shouldRunNumberMarkerFallback`.
- [`documents/metadata-extract.ts`](../documents/metadata-extract.ts) —
  `DOCUMENT_NUMBER_RE`, the single source of truth for the `#1234` marker
  pattern, shared with `text-extract.ts`.
- [`docker/Dockerfile.runtime`](../docker/Dockerfile.runtime) — installs
  `tesseract-ocr-osd`.
