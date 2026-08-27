# Document text extraction

How a PDF becomes the `documents.extracted_text` that classification reads.

Everything here lives in
[`documents/text-extract.ts`](../documents/text-extract.ts) (orchestration and
OCR), [`documents/ocr-layout.ts`](../documents/ocr-layout.ts) (rebuilding page
text from word geometry) and
[`documents/ocr-preprocess.ts`](../documents/ocr-preprocess.ts) (rotation and
contrast — documented separately in [ocr-improvements.md](./ocr-improvements.md)).
The job wrapper is `runTextExtract` in
[`documents/document-ops.ts`](../documents/document-ops.ts).

## Why this document exists

Text extraction is the pipeline's slowest stage by a wide margin, and it runs
single-threaded — `DOC_SCAN_TEXT_CONCURRENCY` defaults to 1 because Tesseract is
CPU-bound. One slow document therefore holds up every document behind it. It is
also the stage whose output quality silently caps everything downstream: the
classifier, the deterministic sender/date scans and the embeddings all read
whatever this produces, and none of them can recover information the extraction
lost.

## The pipeline

```
runTextExtract(documentId)
├── thumbnail warm-up                    (best-effort, never blocks)
├── extractPdfText(path, { forceOcr, docId })
│   ├── 1. encryption gate               qpdf --requires-password
│   ├── 2. text layer                    pdf-parse
│   ├── 3. the decision                  ── text layer usable? → return
│   └── 4. ocrPdf()                      ── otherwise
│       ├── rasterize                    pdftoppm -r 200 -png
│       └── per page:
│           ├── rotation detection       tesseract --psm 0 (+ verification)
│           ├── contrast cleanup         sharp
│           ├── recognition              tesseract --psm 3 → txt + tsv (+ pdf)
│           └── layout rebuild           ocr-layout.ts
│       ├── document-number fallback     tesseract --psm 11, page 1 only
│       └── sandwich PDF                 pdfunite
├── persist / remove the OCR sidecar
├── refresh the served PDF and thumbnail
└── write extracted_text, advance status
```

### 1. Encryption gate

`qpdf --requires-password` classifies the file:

| Result | Meaning | Action |
| --- | --- | --- |
| exit 0 | an open ("user") password is required | throw `PdfPasswordRequiredError` |
| exit 3 | owner/permission restrictions only | `qpdf --decrypt` into a temp copy |
| other | not encrypted | proceed unchanged |

A document needing an open password is parked in the `encrypted` state and its
downstream jobs are dropped, so the UI can prompt for the password instead of
the document failing with a poppler error. A missing `qpdf` binary resolves to
"none" so detection never blocks the pipeline.

### 2. Text layer

`pdf-parse` reads the embedded text layer — under 100 ms for a born-digital
PDF. The result must clear two independent bars:

- **Length** — at least `MIN_TEXT_LAYER_CHARS` (default 80).
- **`hasPoorSpacing`** — four signals, any one of which condemns the layer:
  whitespace ratio, share of over-long "glued" tokens, mean token length, and
  share of tokens with an internal lowercase→uppercase boundary (a dropped
  space between two German words). Thresholds are calibrated so clean prose
  stays well clear while a real partial-space-loss scan trips three of four.

### 3. The decision

If the text layer is usable **and** `forceOcr` is not set, `extractPdfText`
returns immediately. This early return is load-bearing: `ocrPdf` is by far the
most expensive thing the pipeline does, and it used to run for these documents
too, with its result discarded on the next line.

`forceOcr` (persisted per document as `documents.force_ocr`, settable through
the reclassify endpoints) skips the text layer outright. It exists to recover
documents whose text layer is broken in a way `hasPoorSpacing` does not catch.

### 4. OCR

**Rasterize.** `pdftoppm -r 200 -png`, one PNG per page. If that fails with a
recognizably broken cross-reference table, `qpdf` rebuilds the file and the step
is retried once; Ghostscript is the last resort, and only after `pdftoppm` has
actually failed — poppler can rasterize files `pdf-parse` rejects, and `gs` is
expensive.

**Per page**, strictly serially:

1. **Rotation detection** (`detectOcrRotation`) — a Tesseract OSD pass
   (`--psm 0`). A confident 90°/270° is trusted directly. 180° is
   indistinguishable from 0° to OSD, so an ambiguous result is *verified* by
   recognizing the page both as-is and rotated and comparing mean word
   confidence. **That verification costs two more full recognition passes.**
2. **Contrast cleanup** — grayscale, percentile-clip normalize, gentle linear
   stretch, so gray-paper scans reach Tesseract as black-on-white. Best-effort:
   a failure leaves the untouched raster in place, so OCR never regresses.
3. **Recognition** — one `tesseract --psm 3` (`deu+eng`) run emitting `txt`,
   `tsv` and, when a sandwich PDF is wanted, `pdf`. All formats come out of the
   same recognition pass, so asking for the TSV costs a file, not a second run.
4. **Layout rebuild** — see below.

A page can therefore cost up to **four Tesseract invocations**, only one of
which produces the text that is kept. See "Where the time goes".

**Document-number fallback.** If the primary pass found no `#1234`-style marker,
page 1 gets one extra `--psm 11` (sparse text) pass. Such markers sit isolated
in a page corner next to a logo or box, where the default layout analysis fuses
them into the neighbouring graphic and drops them.

**Sandwich PDF.** Tesseract emits a searchable single-page PDF per page (the
cleaned image plus an invisible, positioned text layer); `pdfunite` merges them.
Because it is built from the *cleaned* rasters, the served PDF keeps the
corrected rotation. Best-effort — a failure here never affects the text.

**Timeout.** `OCR_TIMEOUT_MS` (default 10 min) is checked between pages, so it
truncates a long document rather than aborting a page mid-recognition.

## Layout reconstruction

Tesseract's own `txt` output preserves layout *inside* each block it detected,
but emits blocks in its own reading order. On a page with several regions, text
that sits on one visual line ends up dozens of lines apart. So the page text is
rebuilt from the word boxes in the TSV instead:

1. **`parseTesseractTsv`** — word-level rows into boxes. Note that `block_num`
   and `par_num` are deliberately *not* used; see below.
2. **`buildVisualRows`** — words sharing a baseline become one row. Baselines
   (box bottoms) are more stable than box tops when a row mixes font sizes.
3. **`splitColumnBands`** — separates two blocks printed side by side. On a
   German business letter the recipient's address window sits left of the
   sender's contact block; they share baselines, so step 2 merges them into
   single lines. This finds the vertical corridor no word reaches into and emits
   each column's rows in turn. Four guards keep it honest:
   - the corridor chosen must survive as the band grows (otherwise the band runs
     into the body text, where some unrelated gap is still open);
   - lone punctuation does not vote on column position (a scanned page edge
     produces a column of stray `|` marks);
   - both columns must run over at least two rows;
   - if nearly every row reaches across the corridor it is a **table**, and it is
     left joined — splitting would separate a header from the value beneath it.
4. **`formatVisualRow`** — renders a row, turning wide gaps into a column
   separator so a table still reads as a table.
5. **`shouldUseLayoutText`** — the rebuild is only accepted if it retains at
   least 90 % of the "ink" (non-whitespace characters) of Tesseract's own `txt`.
   Otherwise the plain text is used. A failed reconstruction must not silently
   swallow content.

**Why not Tesseract's `block_num`?** It looked like the obvious answer and is
not. Measured on a production insurance letter, Tesseract put the
return-address line and the right-hand column's postcode line in *one* block,
and the recipient's name in a block containing fragments of the contact column.
The geometry its blocks are derived from is sounder than the blocks themselves.

## What downstream depends on this

`runClassify` sends the extracted text to the LLM, and — only where the model
returns nothing — falls back to deterministic scans in
[`documents/metadata-extract.ts`](../documents/metadata-extract.ts):

- `extractSender` reads the letterhead: the comma- or hyphen-joined return
  address above the address window, an address block whose name line names an
  organisation, or a bare letterhead line naming one.
- `extractDocumentDate` prefers a label-anchored date, treats the salutation as
  the boundary between letterhead and body, and reads a date printed under its
  column header by character offset.
- `extractDocumentNumber` takes only an explicit `#1234` marker.

All of these read *lines*. They assume that a line in `extracted_text`
corresponds to a line on the page — which is what the layout rebuild provides.

## Known limitation: the text-layer path gets no layout reconstruction

`layoutTextFromTsv` is reachable only from `ocrPdf`. A born-digital PDF returns
`pdf-parse`'s output verbatim, with no geometric reconstruction at all — no
visual rows, no column separation, no `splitColumnBands`.

The reading order of a text layer is whatever its producer chose. Extracting the
same two-column letterhead without geometry (`pdftotext` without `-layout`,
which is structurally what this path does) yields:

```
Postanschrift:
Beispiel Versicherung AG - Postfach 103969 - 12345 Musterstadt   ← left column
Beispiel Versicherung AG
Postfach 103969
12345 Musterstadt
Max Mustermann                                                   ← recipient
...
Versicherungsnummer:
Versicherungsnehmer:          ← both labels first
R-00000000-00
Max Mustermann                ← then both values
```

Two failures the OCR path does not have: the columns are interleaved, and a
label is separated from its value. `pdf-parse` also concatenates visually
separated items without inserting a space (observed: `Headers:DejaVuSans Bold`),
where `formatVisualRow` would emit a column separator.

So the answer to "can the deterministic extractors read a born-digital PDF as
well as a scanned one?" is: **not necessarily, and we do not currently control
it.** For a simple single-column document the text layer is cleaner than any
OCR of it. For a structured one it can be worse, and nothing in the pipeline
detects the difference — `hasPoorSpacing` catches lost *spaces*, not a
scrambled reading order.

Closing this would mean rebuilding the layout from the text layer's own
geometry (pdf.js exposes per-item transforms; `pdftotext -layout` is the
off-the-shelf equivalent) and feeding it through the same `buildVisualRows` /
`splitColumnBands` path the OCR side uses. Not implemented.

## Where the time goes

Every stage is timed and logged under the document id, so a whole extraction
can be grepped out of the container log with one id:

```
docker compose logs app | grep "extract(3198)"
```

Text-layer document — two lines, and the work is trivial:

```
extract(3198) read 121KB in 1ms, encryption check 10ms, text layer 181ms
              → 10 pages, 4284 chars, usable
extract(3198) done in 192ms — source=text_layer, OCR skipped
```

OCR — one line per page plus a summary naming every stage's share:

```
extract(3198) force_ocr=true — skipping text layer, running OCR
extract(3198) rasterize 2319ms → 10 page(s) @200dpi
extract(3198) page 1/10: rotate 2411ms, clean 292ms, tesseract 1163ms, layout 3ms → 451 chars
...
extract(3198) ocr done in 23407ms — 10 page(s), 2341ms/page: rasterize 2319ms,
              rotate 10293ms, clean 2935ms, tesseract 7793ms, layout 12ms,
              sandwich pdf 41ms
extract(3198) done in 23595ms — source=ocr, 3995 chars
```

And the job wrapper's own total, which also covers the thumbnail and the served-PDF
refresh:

```
[documents] text_extract(3198) done in 24102ms — thumbnail 210ms, extract 23595ms,
            preview 297ms, source=ocr, 3995 chars
```

**The measurement above is the point.** On that ten-page document, rotation
detection cost **10.3 s against recognition's 7.8 s** — 44 % of the total OCR
time spent deciding that pages were upright. That is the verification pass from
step 1: whenever OSD reports 0° with low confidence, the page is recognized
twice more just to rule out 180°. The `rotation probe: as-is=… rotated(…)=…`
line from `ocr-preprocess.ts` marks each page where that happened.

If OCR is starving the queue, read the summary line first: it names which stage
dominates, and the stages have completely different remedies.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `DOCUMENTS_MIN_TEXT_CHARS` | `80` | Minimum text-layer length before it is accepted |
| `DOCUMENTS_OCR_LANG` | `deu+eng` | Tesseract language models |
| `DOCUMENTS_OCR_DPI` | `200` | Rasterization DPI |
| `DOCUMENTS_OCR_TIMEOUT_MS` | `600000` | Per-document OCR budget, checked between pages |
| `DOCUMENTS_OCR_LAYOUT` | `1` | Layout rebuild incl. column splitting; `0` uses Tesseract's plain text |
| `DOCUMENTS_OCR_NUMBER_FALLBACK` | `1` | Sparse-text pass for a missing `#1234` marker |
| `DOCUMENTS_OCR_TIMING_PAGES` | `1` | Per-page timing lines; `0` keeps only the summary |
| `DOC_SCAN_TEXT_CONCURRENCY` | `1` | Parallel text-extract workers (Tesseract is CPU-bound) |

Rotation and contrast have their own switches — see
[ocr-improvements.md](./ocr-improvements.md).

## External binaries

`pdftoppm` (poppler-utils), `tesseract` (tesseract-ocr, with `deu`/`eng`/`osd`),
`qpdf`, `pdfunite`, `gs`. Installed in the backend image — see
`docker/Dockerfile.runtime`.

## Not persisted

`ExtractResult.source` (`text_layer` / `ocr` / `mixed`) is returned and then
discarded. There is currently **no column recording which path a document took**,
so it is not possible to select "all documents that needed OCR" in SQL.
(`documents.ocr_confidence` does not exist; `ocr_confidence` lives on
`document_receipt_extraction` and belongs to the receipt extractor.) Adding it
would make targeted re-extraction possible.
