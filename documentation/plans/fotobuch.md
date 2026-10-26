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
2. **LLM chapters and captions** — the LLM proposes chapter headings from
   time, place, people and the images, and a caption per photo from location,
   POI match with its Wikipedia/Wikidata text (`geo/src/poi-search.ts`) and
   the image (`/vision/json-prompt`, like `photo/critique.ts`). Batch work
   through the `llm` queue. Captions on/off per page and book.
3. **LLM picks the layout** — the rule-based builder produces candidates, the
   LLM ranks them per page from the photo information (orientation, faces,
   scores, captions); measured against the rule-based choice before it is
   adopted.
4. **Subject weighting** — sliders for people, landscape, nature, buildings
   (zero-shot prompts on the CLIP vector, faces, POI matches); near-duplicate
   groups contribute only their pick (`photo/group-auto-pick.ts`).
5. **More sources** — the basket and collections, and an assistant tool that
   proposes a book from the photos of an answer (`from_previous_result`).
   Built on the router and area packages in `assistant/areas/`.
6. **Slideshow** — the same book (chapters, pages, captions) played with the
   recap player (`RecapPlayer.vue`) and music, optionally exported as video.

## Open questions

- Whether print shops want the first inside page alone on the right
  (stage 1 pairs pages 1–2, 3–4, …).
- Which formats and spine formulas of real print shops to add.
- Whether margin and gap should be settings.
