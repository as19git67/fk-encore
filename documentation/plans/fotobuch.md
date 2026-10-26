# Photo book (Fotobuch)

Issue #1729.

## Goal

Help the user design a photo book inside the Photos module: pick the photos,
group them into chapters, lay them out on pages, and export the result as a
PDF — print-ready for a print shop (cover with spine, inside as spreads, bleed
and trim) or as a plain sequence of pages to print at home. Later the local
LLM proposes chapter headings, captions and layouts, and the same book can be
played as a slideshow.

## Decisions

- **A book is a saved object** (`photo_book`, `photo_book_chapter`,
  `photo_book_page`, `photo_book_slot`). Pages and their photos are rows, not
  a JSON blob: a deleted photo drops out of its slot by `ON DELETE CASCADE`,
  and every edit is one small update. A book never rearranges itself after it
  was built; "Neu verteilen" is an explicit action.
- **Sources** are a list of photo ids (a selection in any photo list) or an
  album. Every photo passes `accessiblePhotoCondition` of the book's owner,
  at creation and again at export: a photo the owner lost access to is left
  out of the PDF, never rendered.
- **Narrowing** happens once, when the book is built: minimum quality
  (`ai_quality_score`), minimum aesthetics (`clip_aesthetics`), "without
  recognisable faces", at most N photos (the best by score, back in
  chronological order). The user's hidden photos and videos never enter.
- **Recognisable face** = a detected face whose box covers at least
  `RECOGNISABLE_FACE_MIN_AREA` of the image (0.25 %, about 5 % × 5 %) and
  whose sharpness is unknown or at least `RECOGNISABLE_FACE_MIN_SHARPNESS`
  (0.25, `photo/face-sharpness.ts`). Small, blurred background faces do not
  count. The two numbers live in `photo/photo-book-layout.ts`.
- **Chapters** come from the capture time: one chapter per calendar day when
  the whole set spans at most 31 days, otherwise one per month. A chapter
  with fewer than four photos joins the one before it. Photos without a date
  form a last chapter "Ohne Datum". The default title is the date (and the
  city most of the chapter's photos share), the subtitle the date range and
  duration. Stage 2 lets the LLM propose better headings.
- **Page layouts** are a table in `photo/photo-book-layout.ts`, normalised to
  the page's content box, like the collage layouts: 1 photo (full bleed,
  framed), 2, 3 and 4 photos in several variants, and a chapter opener (title
  plus one photo). The rule-based builder fills a chapter page by page: the
  best photo of a chapter opens it, a photo in the chapter's top tier gets a
  page of its own, the rest go in groups of two to four with the layout and
  cell order that crop the least, the best photo in the largest cell, and
  never the same layout twice in a row. Cropping keeps the focal point
  (`auto_crop`) inside, the same `coverCrop` the recap export uses.
- **Resolution**: every slot reports the dpi it will print at; below 200 dpi
  the editor warns.
- **The user's own edits** (`photo_transforms`, crop and colour) are applied
  when the PDF is rendered (`renderUserAndCache`).
- **PDF** with `pdfkit`, images through `sharp` at up to 300 dpi:
  - *Print shop*: two files. `cover.pdf` is one sheet — back, spine, front —
    with bleed; the spine is `pages / 2 × paper thickness` wide. `inside.pdf`
    holds the pages as spreads (left and right page on one PDF page) or as
    single pages, each with bleed; optional crop marks in a slug outside the
    bleed. An odd page count is padded with an empty page.
  - *Home*: one file, the cover's front and then the pages, each its own PDF
    page at trim size, no bleed, no spine.
  - Rendering runs as an in-process job (like the recap export) and writes
    to `PHOTO_BOOK_EXPORT_DIR`; the file name carries a random token and the
    download endpoint is served like the recap export's.
- **Formats** (trim size): A4 landscape, A4 portrait, 21 × 21 cm,
  30 × 30 cm. Margin and gap are fixed in stage 1 (12 mm, 4 mm).

## Stages

1. **Book, rule-based layout, PDF** (implemented) — tables, building from a selection or an
   album with the narrowing above, chapters from capture time, rule-based
   pages, editor (titles, layout per page, cover photo, remove a photo,
   rebuild), PDF for the print shop and for home. Entry points: "Fotobuch
   gestalten" in the gallery's selection bar and on the album page, list under
   Fotos › Fotobücher.
2. **LLM chapters and captions** (implemented) — `photo/photo-book-ai.ts`
   with the prompts in `photo-book-prompts.ts`. A caption per photo from
   place, a confident POI match with the start of its Wikipedia article, the
   owner's named people and the image (`/vision/json-prompt`); without the
   projector it is written from the facts alone, and a photo without facts
   gets none. Chapter titles from time, places, people and the captions; a
   title the user wrote stays and the model's proposal is shown next to it
   to take ("Übernehmen"). Runs in the `llm` slot at background priority,
   started from the book's page ("KI"), never while the GPU is lent.
   A caption is written only when there is something concrete to say — a
   place, a landmark, people the owner named, the photo's description, text
   the recognition read on a sign in it (lines at confidence ≥ 0.8) or the
   spot of one of the owner's trips it was taken at (a planned stop that day
   or a stay in the visit diary, within 150 m) —
   and is kept only when it names one of them (`captionNamesAFact`); a
   caption that merely describes the picture ("Ein alter Keller") is dropped,
   and "neu schreiben" removes such an earlier one. A page says a caption once:
   the model is told the captions already on the page and a repeat is
   dropped, and the same text under several photos of a page (also the
   user's) is shown and printed only under the first (`repeatedCaptions`).
   Captions on/off for the book and per page (`photo_book_page.captions`,
   null follows the book); in the PDF a strip below a framed photo or a band
   inside a full-bleed one (`slotGeometry`). Captions live in
   `photo_book_caption` with `source` `llm`/`user`; a user caption is never
   overwritten.
3. **LLM picks the layout** (implemented) — `rankLayouts` gives every layout
   with its best cell order; the model picks among the best
   `LAYOUT_CANDIDATES` (4) from the photos' orientation, faces, scores and
   captions, and a pick that crops more than `LAYOUT_MAX_EXTRA_COST` (0.1)
   beyond the best is refused. Each page records `layout_origin`,
   `rule_layout` and the model's reason; a page the user changed is
   `layout_source = 'user'` and never picked again. The measurement is how
   often the user changes a page, rule against model
   (`GET /photo-books-layout-stats`, shown in the KI dialog).
4. **Subject weighting** (implemented) — `photo/photo-book-subjects.ts`.
   Weights −1 … 1 for people, landscape, nature, buildings move a photo's
   score by at most 30 points per subject. Shares from zero-shot CLIP
   prompts on the stored vector (`/zero-shot/score` of the embedding
   service, with a catch-all label), faces (a recognisable face counts
   fully) and confident POI matches (buildings). Without the embedding
   service only faces and landmarks count. A series of near-duplicates the
   owner has not reviewed contributes only the model's pick, else its best
   photo. On top, photos that merely look alike (DINOv2 cosine ≥ 0.80, the
   same scene a few minutes apart, compared within runs of photos at most
   3 h apart through `/redundant-pairs`) are thinned to the best one
   (`dropSimilarPhotos`). Both on by default, off with "Ähnliche Fotos nur
   einmal" unticked.
   The narrowing (quality, aesthetics, faces, maximum, series, weights) can
   be changed afterwards with "Auswahl" on the book's page; the book is then
   laid out again from its source (`POST /photo-books/:id/rebuild` with
   `narrowing`).
5. **More sources** (implemented) — a collection as source
   (`kind: "collection"`: its photos and the photos of its albums, as far as
   the owner may see them, read again on "Neu verteilen"); the basket is
   copied into a photo list when the book is made. Entry points in the
   basket drawer and on the collection page. Assistant tool
   `create_photo_book` (`assistant/tools/photo-book.ts`, area photos), a
   write proposal from `from_previous_result`, ids or an album, with the
   narrowing and weights.
6. **Slideshow** (implemented) — "Diashow" on the book's page plays it in
   the recap player: one slide per page in reading order, chapter titles on
   the opener, the page's first caption when the page shows captions, pages
   of four or more as collages of two or three
   (`frontend/src/utils/photoBookSlideshow.ts`, prop `plan` of
   `RecapPlayer.vue`), to the recaps' music. A video export is left open.

## Open questions

- Whether print shops want the first inside page alone on the right
  (stage 1 pairs pages 1–2, 3–4, …).
- Which formats and spine formulas of real print shops to add.
- Whether margin and gap should be settings.
