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
│   ├── 2. text layer                    pdf-parse + pdf-text-layout.ts
│   ├── 3. the decision                  ── text layer usable? → return
│   └── 4. ocrPdf()                      ── otherwise
│       ├── rasterize                    pdftoppm -r 200 -png
│       └── per page:
│           ├── rotation detection       tesseract --psm 0 (+ verification),
│           │                             reused across same-shape pages
│           ├── contrast cleanup         sharp
│           ├── recognition              tesseract --psm 3 → txt + tsv (+ pdf)
│           ├── layout rebuild           ocr-layout.ts
│           └── resolver (opt-in)        ocr-uncertainty.ts → ocr-resolver.ts
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

1. **Rotation detection** (`PageRotationSampler`) — a Tesseract OSD pass
   (`--psm 0`). A confident 90°/270° is trusted directly. 180° is
   indistinguishable from 0° to OSD, so an ambiguous result is *verified* by
   recognizing the page both as-is and rotated and comparing mean word
   confidence. **That verification costs two more full recognition passes.**

   The OSD pass is not free either — it is a full Tesseract start-up plus a
   pass over the page, measured at ~1.6 s against ~1.8 s for the recognition
   that actually produces text. So a *confident upright* verdict is reused
   across the document's remaining pages instead of being re-derived on each:
   pages are keyed by shape (portrait/landscape, read from the PNG's IHDR
   chunk), and only `0°` is ever extended. The asymmetry is deliberate —
   wrongly extending "upright" leaves a page unrotated, which is what the
   pipeline did before auto-rotate existed; wrongly extending `90°` would spin
   a page that was already fine and destroy text that reads perfectly. A
   document that genuinely needs rotating therefore keeps paying full
   detection on every page. `DOCUMENTS_OCR_ROTATE_REUSE=0` restores per-page
   detection.
2. **Contrast cleanup** — grayscale, percentile-clip normalize, gentle linear
   stretch, so gray-paper scans reach Tesseract as black-on-white. Best-effort:
   a failure leaves the untouched raster in place, so OCR never regresses.
3. **Recognition** — one `tesseract --psm 3` (`deu+eng`) run emitting `txt`,
   `tsv` and, when a sandwich PDF is wanted, `pdf`. All formats come out of the
   same recognition pass, so asking for the TSV costs a file, not a second run.
4. **Layout rebuild** — see below.

A page can therefore cost up to **four Tesseract invocations**, only one of
which produces the text that is kept. With the rotation verdict reused, the
usual page costs one. See "Where the time goes".

**Document-number fallback.** If the primary pass found no `#1234`-style marker,
page 1 gets one extra `--psm 11` (sparse text) pass. Such markers sit isolated
in a page corner next to a logo or box, where the default layout analysis fuses
them into the neighbouring graphic and drops them.

**Sandwich PDF.** Tesseract emits a searchable single-page PDF per page (the
cleaned image plus an invisible, positioned text layer); `pdfunite` merges them.
Because it is built from the *cleaned* rasters, the served PDF keeps the
corrected rotation. Best-effort — a failure here never affects the text.

**Timeout.** `OCR_TIMEOUT_MS` (default 10 min) is checked between pages, so it
truncates a long document rather than aborting a page mid-recognition. **A
truncated document looks exactly like a complete one from the outside** —
partial text, status `ready`, no error — so it is reported in the log under the
document id and persisted as `pages_ocred < pages_total`:

```
extract(3198) OCR time budget of 600000ms exhausted after 241/380 page(s) —
              TRUNCATING. Raise DOCUMENTS_OCR_TIMEOUT_MS to extract this document in full.
extract(3198) INCOMPLETE — 241/380 page(s) recognized before the time budget ran out
```

At the measured ~1.4 s/page (Tesseract alone) or ~2.5 s/page (with the second
engine) the default reaches roughly 430 resp. 240 pages. Raising it is cheap in
itself; the cost is that `DOC_SCAN_TEXT_CONCURRENCY=1` makes one such document
block the queue for the whole duration.

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

## The text-layer path: separators recovered, reading order not

`pdf-parse` renders a page by walking text items in content-stream order,
breaking a line whenever the baseline y changes and **concatenating items that
share a baseline with nothing between them**. Two defects follow.

**Missing separators — fixed.** Items printed far apart on one line arrived
fused: `12345 MusterstadtMax Mustermann`, `Versicherungsnummer:R-00000000-00`,
and on a real PDF from pdf-parse's own corpus
`Categories and Subject DescriptorsD.3.4` and `KeywordsJavaScript`. Nothing
downstream noticed: `hasPoorSpacing` looks for spaces lost *inside* words, and a
fused pair trips at most one of its four signals.

`pdf-text-layout.ts` supplies a `pagerender` that keeps pdf-parse's item order
and line breaks exactly, and inserts a separator only where the items' own
coordinates prove there is horizontal space — a single space across an ordinary
word gap, the same three-space `COLUMN_SEPARATOR` the OCR path uses across a
column-width one. An item that starts *left* of the previous one cannot be that
one continuing (a split word advances rightward), so it is separated too; this
is the common case where content-stream order emits a right-hand column before
the left-hand one sharing its baseline. Items that genuinely abut are left
fused, because that is a word split by a style change and a space would break
it.

The change can only ever add characters. Verified on pdf-parse's corpus: ink
(whitespace stripped) is identical before and after on all four documents, and
the two-column journal article is byte-for-byte unchanged.
`DOCUMENTS_TEXT_LAYER_SPACING=0` restores the fused rendering.

**Reading order — still whatever the producer chose.** Content-stream order is
the order the text was written, not the order it appears. Rebuilding the page
from geometry the way the OCR path does was built and measured, and is not safe
to ship:

- On a two-column letterhead it worked, pairing rows correctly
  (`Versicherungsnummer:   R-00000000-00`).
- On a two-column journal article it destroyed the page. Merging by baseline
  fused the two columns of every visual line and `splitColumnBands` did not
  separate them again — it is tuned on Tesseract's word boxes, which are many
  and narrow, while text-layer items are few and wide, so its gap statistics
  read completely differently. Splitting items into words to imitate that input
  shape produced interleaved word salad.

Both variants passed `shouldUseLayoutText`, which compares *ink* — 15782
characters either way on the article. Ink cannot see a scrambled reading order,
the same blind spot `hasPoorSpacing` has. Closing this needs column separation
that works on text-layer geometry; `splitColumnBands` does not currently provide
it. Not implemented.

## Small PDFs never reached the text layer at all

Node pools allocations under 8 KB, so `fs.readFile` on a small file returns a
Buffer that is a *view* into a shared 8192-byte pool at a non-zero
`byteOffset`. The pdf.js build bundled in pdf-parse reads the underlying
ArrayBuffer without honouring that offset, parses the pool instead of the PDF,
and throws `bad XRef entry` on a document poppler reads without complaint.

Every PDF under ~8 KB therefore failed the text-layer read and fell through to
OCR — slower, and worse than the text layer it already had. Larger files get
their own ArrayBuffer at offset 0 and were never affected, which is why it went
unnoticed. `ownedBytes` copies into a `new Uint8Array(n)`, which always owns an
exactly-sized ArrayBuffer.

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
time spent deciding that pages were upright.

The obvious suspect was the verification pass from step 1, but measuring it
separately showed otherwise: on a real scan the OSD call alone takes ~1.6 s
against ~1.8 s for recognition, and it returned `Rotate: 0` at confidence 8.4 —
comfortably above the threshold, so verification never ran. The cost was simply
one full Tesseract start-up per page to confirm the page was upright.

Reusing that verdict across pages of the same shape (step 1) is what the
`(reused)` markers in the timing lines report. On a five-page scan:

```
rotate 14549ms                → rotate 3746ms (4 reused)
```

−74 % on the stage, with byte-identical output (6808 chars either way). The
`rotation probe: as-is=… rotated(…)=…` line from `ocr-preprocess.ts` still
marks each page where the verification pass did run.

If OCR is starving the queue, read the summary line first: it names which stage
dominates, and the stages have completely different remedies.

## The resolver: a second opinion on suspect spans

Tesseract does not fail loudly. A printed `23 AUG 02` comes back as `23 aus oz`
with exactly the shape of output a perfect line produces, and everything
downstream reads it as fact. The resolver is the opt-in stage that looks again
at the places where that is likely to have happened.

It sits inside the layout step, between row grouping and rendering, because a
span must never straddle a column boundary — `splitColumnBands` is what
establishes where those are.

```
rows (visual, post-splitColumnBands)
  │
  ├── ocr-uncertainty.ts   which spans look wrong?
  │     low_confidence · implausible_charset · pattern_miss
  │
  └── ocr-resolver.ts      what do they actually say?
        ├── PaddleOCR on the page          (DOCUMENTS_OCR_SECOND_ENGINE=1)
        ├── crop + margin + upscale → VLM  (DOCUMENTS_OCR_VLM=1)
        └── decide, then write back into the rows
```

**Both stages are off by default.** With both off the uncertainty scan does not
run at all, and the page text is byte-for-byte what it was before.

### Which spans

[`ocr-uncertainty.ts`](../documents/ocr-uncertainty.ts) marks a word suspect
when its TSV confidence falls below `DOCUMENTS_OCR_CONF_THRESHOLD`, or when its
character mix does not occur in real print — a digit-confusable letter inside a
mostly-numeric token (`20,1l`), a capital inside a lowercase-initial token
(`aUs`), a run of pure punctuation from a scanned page edge. A marked word is
then grown over its neighbours as far as ordinary word gaps reach, so `23` is
cropped together with the `aus oz` that follows it: a crop of the damaged words
alone has no date shape left in it. Finally the span's whole text is tested
against the shapes the pipeline knows (date, amount, IBAN, `#1234` marker); a
near-miss adds `pattern_miss`.

The confidence data this rests on was always there — Tesseract writes it into
the same TSV the boxes come from, and `parseTesseractTsv` simply dropped the
column.

### Which reading wins

[`ocr-resolver.ts`](../documents/ocr-resolver.ts) collects up to three readings
of the same pixels and decides between them in a fixed order:

1. **Two engines agree** → no model is called, and the *incumbent* reading
   stands. Agreement is tested on a *confusable fold*: `AUG` and `AUC` fold
   together, `7.500` and `7.800` deliberately do not. That asymmetry is what
   makes folding safe — two engines reading a different amount can never look
   like agreement.
2. **A model answer passes validation** → the model's reading.
3. **Otherwise** → the incumbent reading, and the disagreement is recorded.

Step 3 is the property the whole stage rests on: **the pipeline can never end
up worse than it is today.** A model that is absent, slow, wrong or
hallucinating yields the text the pipeline would have produced anyway.

### Why PaddleOCR never overwrites Tesseract

Steps 1 and 3 used to take the *highest-confidence* OCR reading. Measured over
3440 spans of real paperwork, that handed PaddleOCR **1194 of 1224
disagreements — 97.5 %**. Not because it read better: the two confidence scales
are simply not comparable. On flagged spans Tesseract averages **0.516** and
PaddleOCR **0.953**, so a maximum over the two is a standing preference for one
engine dressed up as a decision.

The preference cost accuracy. Of the disagreements whose outcome can be
classified without a ground truth, every measurable class pointed the same way:

| | |
| --- | ---: |
| PaddleOCR loses a diacritic | 89 |
| PaddleOCR gains a diacritic | 25 |
| PaddleOCR truncates the line | 41 |
| German decimal comma → period | 4 |

For German documents the first row is the expensive one — 3.6 losses per gain.

So the incumbent stands until something can actually adjudicate, which is the
vision stage. PaddleOCR's job is to *find* the disagreement, and it does that
well: 1224 genuine flags is exactly the worklist the third stage exists for.
The cost is real and accepted — where PaddleOCR was right and Tesseract wrong,
the span keeps the worse reading. But it is flagged, and a flagged error is
reachable in a way a silent one is not.

The same measurement showed PaddleOCR contributing **no reading at all** for
44.3 % of flagged spans, which is a further reason not to promote it: it is
silent on nearly half of exactly the material it was brought in for.

These numbers come from [`analyze-resolver-log.mjs`](../scripts/ocr/analyze-resolver-log.mjs),
which reads them out of the `resolver-span` debug lines.

### Specks are not spans

A box smaller than a printed glyph is scanner noise, not text. Tesseract reads
such specks as `.`, `|` or `'` with low confidence, so they flagged as
uncertain, consumed the per-page span budget — and, because `overlapRatio`
normalises by the span's *own* area, sat fully inside any PaddleOCR line that
contained them and matched it at ratio 1.0. One 2 × 2 px speck pulled in an
entire unrelated line as its "second reading".

`tooSmallToRead` now drops them before a span is emitted: below 4 px wide or
8 px tall at the default 200 dpi. The thresholds are dimensions rather than an
area, because a 1 × 27 px table rule is just as degenerate as a dot. On the
measured corpus this removed **530 of 3440 spans (15.4 %)**, none of them
text.

PaddleOCR is reached through a new `POST /ocr/page` on the `receipt-ocr-service`
— deliberately not `/extract`, which corrects perspective on a photographed
till roll and would warp a page that is already flat. It does no preprocessing
of its own, so the two engines disagree about the *text* rather than about the
pixels. Paddle returns *line* boxes where Tesseract returns *word* boxes, so
alignment is by geometric overlap.

### Judging an answer against a span that is not one line

A validated model answer replaces OCR's, so the validator decides what reaches
the stored text. One of its tests measures how far the answer is from what OCR
read — and that test is meaningless on a span covering more than one visual
line.

Those exist. The row grouping merges a two-line logo into a single "row", and
its box comes out ~100 px tall where a line at 200 dpi is ~18 px. Tesseract
emits the words of such a box in its own reading order, the model in visual
line order:

```
tesseract   Kissing-Mering Raiffeisenbank gTerng eG
model       Raiffeisenbank
            Kissing-Mering eG
```

Every word of the answer is one Tesseract also read, and the correction of
`gTerng` is exactly what the stage exists for — but character-by-character the
distance is 0.64, over the 0.5 threshold, and it was refused. The metric was
measuring the ordering, not the reading.

So the test depends on the shape of the answer. A single-line answer keeps the
character distance, where order is meaningful and which caught a CJK glyph
answered for a speck on a German bank statement. A multi-line answer is judged
on `tokenOverlap` instead: at least half its words must be words some OCR
engine also read. An answer that reached into the neighbouring line brings
mostly new words with it and is still refused.

### Why the model only ever sees a crop

Handing a whole page to a vision model costs tokens, invites hallucination, and
gives the ambiguous glyphs no more resolution than they had. A crop is cut with
`DOCUMENTS_OCR_VLM_MARGIN` (default 20 %) of context on each side — enough for
the model to see that the run sits under `Rechnungsdatum` — and upscaled to
`DOCUMENTS_OCR_VLM_CROP_HEIGHT`, because at 200 dpi a date line is ~18 px tall,
far below what a vision encoder resolves.

The prompt asks for a transcription and says the OCR reading is an unreliable
hint. It never asks the model to *correct* anything: a model told to fix OCR
output uses its language knowledge to do so, which is right for
`23 aus oz` → `23 AUG 02` and catastrophic for `7.500` → `7.800`. It cannot
tell those two situations apart, so it is not asked to.

Every answer is then validated before it is accepted, and rejected when it is
empty, describes the image instead of transcribing it, differs in length from
the OCR reading beyond a ratio, rewrites more than half the characters, uses
characters outside the expected type's charset — or produces a *third* reading
on a span whose only defect was that two engines disagreed. In that last case
the model is arbitrating between two candidates, not resolving a weak glyph,
and a brand-new value would be unverifiable.

### When the pairing fails, not the reading

[`ocr-fields.ts`](../documents/ocr-fields.ts) pairs labels with values off the
page's geometry — `Rechnungsdatum  23.08.2002` on one row, a lone label with
its value beneath, a header row with values in columns — and each label yields
the type its value should satisfy. That is what makes `Invoice No.  E0300008SA`
an identifier rather than an implausible token needing a rule to excuse it.

Sometimes the geometry does not deliver: a form whose captions and fields do
not line up, a value printed somewhere its label does not predict. Then the
characters are fine and the *assignment* is what is missing — and a crop cannot
supply it, because the layout is exactly what a crop removes. This is the one
place a whole page goes to the model.

**It fires on three conditions together:**

| | Default | Why |
| --- | --- | --- |
| typed labels with no value | ≥ 2 | One is usually a false positive — a `vom` inside prose, a column empty on this page |
| …as a share of the page's labels | ≥ 50 % | Below that one field slipped; above it the positional assumptions do not hold for this layout at all |
| a span still in doubt after the crops | required | A better pairing buys nothing where the text is already right — this is what keeps the call off clean pages |

Plus its own per-document budget (`DOCUMENTS_OCR_FIELD_VLM_MAX_PAGES`, default
1), separate from the crop budget because a page costs a multiple of a crop,
and a downscale to `DOCUMENTS_OCR_FIELD_VLM_MAX_PX` — a 200-dpi A4 page is
~2480 px wide, far more than a vision encoder uses.

**The safety argument for handing over a page** is different from the crop's
and stricter: the model may *rearrange* what OCR read, never add to it. Every
value it returns is located among the page's own words
(`locateValue`, matched on the confusable skeleton) and dropped when it is not
there — so a plausible invented date cannot survive, and the accepted field
carries the page's own reading rather than the model's rendering of it. That
lookup does double duty: it is the validation, and it recovers the geometry the
model cannot supply.

### Cost control

Text extraction is single-threaded (`DOC_SCAN_TEXT_CONCURRENCY=1`) and a
ten-page scan already costs ~23 s, so:

- Paddle runs **once per page, and only on pages that carry a flagged span** —
  a clean page costs nothing extra.
- Model calls are capped per **document** (`DOCUMENTS_OCR_VLM_MAX_SPANS`) and
  bounded by a per-document deadline (`DOCUMENTS_OCR_VLM_BUDGET_MS`), checked
  between spans the way `OCR_TIMEOUT_MS` is checked between pages.
- Both are reported separately in the timing lines, because their milliseconds
  would otherwise be charged to the layout rebuild, which measures at ~3 ms:

```
extract(3198) page 1/10: rotate 2411ms, clean 292ms, tesseract 1163ms,
              layout 3ms, paddle 812ms, vlm 4210ms → 451 chars
extract(3198) resolver: 7 span(s) — 3 engine agreement, 3 vlm accepted,
              1 vlm rejected, 0 ocr kept (0 engine disagreement, 0 no second reading)
```

Read the resolver line first. `vlm rejected` climbing is a model or prompt
regression. Inside `ocr kept` the two figures mean opposite things and are
counted apart for that reason:

- **engine disagreement** — PaddleOCR read the span and said something else.
  Real signal, and exactly the work the vision stage exists for.
- **no second reading** — PaddleOCR contributed nothing to that span, because
  it detected nothing there or its line boxes did not align. The second engine
  is not doing its job on those, and the alignment is what to look at.

The distinction was added after a first production run reported 182 spans with
132 of them "ocr kept": a number that could equally have meant "the engines
disagree constantly" or "the second engine is inert", which lead to opposite
next steps. `DOCUMENTS_OCR_DEBUG=1` additionally emits one JSON line per span
(`resolver-span {...}`) carrying the box, the reasons, every candidate and the
decision — a log line rather than a file, so a whole resolution greps out under
the same document id as the rest of the extraction, and there is no derived
artifact to invalidate or clean up.

### The vision model itself

The service side lives in `llm-service`: `POST /vision/transcribe`. The model
does not need to be a separate one — an image-text-to-text model such as Gemma 4
already sees. What llama.cpp needs is the **projector file**, which it keeps
separate from the GGUF weights: fetch it via `extra_urls` and point
`LLM_MMPROJ_PATH` (or a configuration's `mmproj_path`) at it. `LLM_BACKEND` must
be `server`; the in-process runtime has no multimodal path. Without a projector
the endpoint answers 503 and says so, and `/healthz` reports `llm_mmproj_path`.

Vision calls share the single inference worker with classification, so they wait
rather than fail — a crop that queues behind a classify is better than one that
503s and silently leaves the OCR reading in place.

### Measuring it

`npm run measure:ocr` renders a synthetic corpus of German document lines under
the degradations that defeat the pipeline in production (blur, grain, gray
paper, small print), runs each engine over it and reports the character error
rate. `--paddle` and `--vlm` add the other two engines.

The corpus is generated rather than checked in — real documents may not enter
the repository — so it answers *which engine reads these failure classes
better*, which is what a ranking needs. It is not a substitute for measuring on
real scans.

### The budget must not be billed for the queue

Each crop takes the single shared AI slot for the model call, so a document
whose neighbours are busy waits before its call runs. That wait was being
charged to the document's own allowance: the timer started before the slot was
acquired, and `spentMs` grew by the wait plus the call.

The effect is not subtle. Measured over a 27-document batch:

| | model time per crop | crops examined |
| --- | ---: | ---: |
| document running alone | 804 ms | 21 of 23 spans |
| documents running concurrently | 13 000 – 32 000 ms | 2 – 3 per document |

The second row is not the model getting slower; it is the queue being counted
as model work. With a 30 s allowance, one wait exhausted it. **298 of 485
flagged spans — 61 % — were never sent to the model.** They appear in the log
as `ocr kept`, a phrase that reads like a decision was made. None was.

The timer now runs inside the slot, so only the call is charged. The wait is
still reported, separately, in the per-document summary:

```
vlm 50835ms (46200ms queued)
```

Contention is a real cost and worth seeing — it just is not this document's
allowance to spend. Wall-clock stays bounded one level up, by
`DOCUMENTS_OCR_TIMEOUT_MS`.

The guard for this lives in `documents/ocr-resolver-budget.test.ts` and drives
`resolvePage` against a slot that makes every call wait. The older assertion in
`ocr-resolver.test.ts` named this property but exercised only the predicate
`vlmBudgetLeft`, so it stayed green throughout — a test that cannot fail on the
bug it names is worth less than no test, because it is read as coverage.

## The letterhead: the two fields nothing labels

Every route to the document date and the sender was keyed on a *printed label*:

| layer | needs |
| --- | --- |
| layout pairing | a label it can pair a value to |
| `assignFields` (whole-page vision) | an **unpaired label** to ask the model about |
| regex fallbacks | an anchor word (`…datum`, `vom`, `Ort,`) |

A German business letter prints none of them. It sets the date alone at the top
right and the sender in the logo block, and expects the reader to know what
they are from *where they are on the page*. So the vision stage could not reach
this case at all — no label, no question, no model call — and the classifier
could not either: it is handed reading-order text, in which the date lands
between a franking mark and a routing code, indistinguishable from a contract
number. The position was discarded before any model saw the document.

### Text, not coordinates

`/vision/letterhead` is asked no labels. It asks what the letter's date is and
who wrote it, and the model answers by **reading the values out** — not by
returning bounding boxes.

That choice is deliberate. Small vision models are unreliable at grounding but
good at reading, and a box that cannot be verified is worse than no box: it
would aim the crop stage at the wrong pixels with full confidence. Instead the
answer is located in the OCR words, which already carry coordinates
(`anchor` in `documents/letterhead.ts`). The trust runs the other way round —
**the model proposes, the page disposes** — which is the same discipline
`assignFields` applies to its values, and the reason a hallucinated sender
cannot reach the database.

`anchor` compares on `confusableFold`, which drops whitespace, hyphens and dots
and folds the glyph pairs OCR confuses. Two consequences matter:

- a window may **cross a row boundary**, because a letterhead name is routinely
  set across two lines and a matcher confined to one row would find only half
  of it;
- the match tolerates a quarter of its length in edit distance, because the
  model and the OCR disagree about exactly the glyphs this pipeline exists to
  repair. Demanding equality would reject precisely the answers worth having.

### Ranking, not preference

The vision reading does not simply win. A model reading a whole page has more
room to go wrong than a label-anchored scan, so all three readers — vision, the
scan, the classifier — are offered to `rankReadings`, which orders them by
evidence:

1. **two readers agree** on a value, which is stronger than any single reader;
2. **the reading was located** in the page's own words;
3. source order, as a last tie-break.

A reading that could not be anchored is kept rather than dropped: absence of a
match is a weaker claim, not a disqualification, and it is the one reader that
can still see the layout when OCR mangled the letterhead badly enough that
nothing matches — which is when it is most useful.

### Where it runs, and why it must

Inside `text_extract`, on page 1 only. Anchoring needs the word boxes and the
model needs the page raster; by the time `classify` runs, the temporary rasters
are gone and the text has been flattened into reading order. The result is
persisted (`documents.letterhead`, migration 0156) because the two are separate
jobs.

It has **no switch**, unlike the span resolver, and deliberately so. There is
no configuration under which not doing it is the better answer: it costs one
call, it cannot make the stored text worse — the ranking has to prefer it, and
it is discarded unless the page's own words carry it — and a deployment without
a projector gets a 503 on the first round trip and carries on unchanged. The
one thing it requires is the Tesseract TSV, which is where the word boxes come
from, so it runs whenever the layout rebuild does.

The cost is real and worth stating: one page-sized call per document, on the
same single AI slot the span resolver queues for. A page image prefills at a
multiple of a crop, so on a large batch this is the dominant addition — and it
is visible as such, since the per-document summary reports it separately
(`letterhead 4310ms`).

### Prompt changes no longer need an image build

The vision prompts now live in `documents/classify-prompts.ts` and are pushed
with the classify prompts over `PUT /prompts`; the service keeps compiled-in
copies as defaults so an older service and a newer app still agree. Without
this every wording change cost the ~55-minute `llm-service` image build — and
wording is most of what decides whether this endpoint answers well.

They are in **English**, unlike every classify prompt, because the instruction
describes *positions on a page* rather than German document vocabulary, and the
models follow spatial instructions markedly better in English. The page itself
supplies the German.

### What this does not fix

The regex fallbacks stay. They are now a cross-check rather than the primary
reader, and `rankReadings` will prefer a value they and the model both arrive
at over either alone. The provenance line says which reader won:

```
[documents] metadata(7326): date=vision, sender=scan
```

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
| `DOCUMENTS_TEXT_LAYER_SPACING` | `1` | Restore separators between fused text-layer items; `0` keeps pdf-parse's rendering |
| `DOCUMENTS_OCR_ROTATE_REUSE` | `1` | Reuse a confident upright verdict across pages of the same shape; `0` detects every page |
| `DOC_SCAN_TEXT_CONCURRENCY` | `1` | Parallel text-extract workers (Tesseract is CPU-bound) |
| `DOCUMENTS_OCR_SECOND_ENGINE` | `0` | Run PaddleOCR as an independent second opinion on pages carrying a flagged span |
| `DOCUMENTS_OCR_VLM` | `0` | Allow the vision model to transcribe unresolved spans |
| `DOCUMENTS_OCR_CONF_THRESHOLD` | `70` | Word confidence below which a span is suspect |
| `DOCUMENTS_OCR_VLM_MAX_SPANS` | `8` | Hard cap on model calls per document |
| `DOCUMENTS_OCR_VLM_BUDGET_MS` | `30000` | Per-document resolver budget, checked between spans |
| `DOCUMENTS_OCR_VLM_MARGIN` | `0.2` | Crop margin as a fraction of the span box |
| `DOCUMENTS_OCR_VLM_CROP_HEIGHT` | `96` | Height a crop is upscaled to before it is sent |
| `DOCUMENTS_OCR_VLM_TIMEOUT_MS` | `90000` | Per-crop budget for the vision call |
| `DOCUMENTS_OCR_PAGE_TIMEOUT_MS` | `30000` | Per-page budget for the PaddleOCR call |
| `DOCUMENTS_OCR_DEBUG` | `0` | Emit one `resolver-span` / `resolver-field` JSON line per span and field pair |
| `DOCUMENTS_OCR_FIELD_VLM_MIN_UNPAIRED` | `2` | Typed labels without a value before a whole-page look is considered |
| `DOCUMENTS_OCR_FIELD_VLM_MIN_RATIO` | `0.5` | …and their minimum share of the page's typed labels |
| `DOCUMENTS_OCR_FIELD_VLM_MAX_PAGES` | `1` | Whole-page assignment calls per document |
| `DOCUMENTS_OCR_FIELD_VLM_MAX_PX` | `1600` | Longest edge a page is scaled to before it is sent |
| `DOCUMENTS_OCR_FIELD_VLM_TIMEOUT_MS` | `180000` | Per-page budget for the assignment call |

Rotation and contrast have their own switches — see
[ocr-improvements.md](./ocr-improvements.md).

## The search index has a ceiling, and it no longer fails the write

`text_tsv` feeds the lexical half of search. It used to be a
`GENERATED ALWAYS ... STORED` column, so `to_tsvector` ran as part of every
write — and PostgreSQL caps a tsvector's lexeme content at 1 MB. Because the
column was generated, hitting that cap aborted the whole `UPDATE`: the document
went to `failed` and its entire extracted text was discarded, over an index
that could simply have been shorter.

The cap is reachable, though not by prose. What accumulates distinct lexemes is
**tables of numbers** — every date, amount and reference on a bank statement is
its own lexeme — and pathological OCR where nearly every token is unique
garbage. Measured on PostgreSQL 16:

| Text | Size | tsvector |
| --- | --- | --- |
| Business-letter prose | 2.26 MB | 4.7 KB |
| Statement, 40 000 transactions | 3.15 MB | 885 KB |
| Statement, 80 000 transactions | 6.3 MB | **error** |

At ~50 transaction lines per page that puts the ceiling near 1 200–1 600 pages,
i.e. roughly an hour of OCR — so the time budget binds long before the index
does, and raising `DOCUMENTS_OCR_TIMEOUT_MS` to 30 minutes stays well clear.
Documents whose OCR produces mostly unique garbage reach it sooner, at a couple
of hundred pages.

Migration 0155 replaces the generated column with a trigger that catches the
failure and retries on the first 400 000 characters. Everything that fits is
indexed in full; the pathological case is indexed up to the cut and logs a
warning; `extracted_text` is never touched, so the document keeps all of its
text either way. The trigger fires on the same columns the generated
expression covered, including `tags_text`, which the tag triggers maintain.

## External binaries

`pdftoppm` (poppler-utils), `tesseract` (tesseract-ocr, with `deu`/`eng`/`osd`),
`qpdf`, `pdfunite`, `gs`. Installed in the backend image — see
`docker/Dockerfile.runtime`.

## Persisted since migration 0154

`ExtractResult.source` used to be returned and then discarded: the only record
was a console.log line, so "which documents actually needed OCR?" could not be
asked in SQL at all, and a container restart erased even the log. That gap is
load-bearing for any measurement of an OCR change — a classification sample
drawn without knowing which documents were OCR'd cannot show whether the change
moved anything, because a corpus of born-digital PDFs never reaches the OCR
path.

`documents.text_source` (`text_layer` | `ocr` | `mixed`) and
`documents.ocr_mean_confidence` (mean per-word Tesseract confidence, 0..100,
word-weighted across pages) now carry both, and `documents.pages_total` /
`documents.pages_ocred` (migration 0155) record whether the OCR time budget cut
the document short. Diagnostics only — nothing decides
anything on them — and NULL means "extracted before the migration". A partial
index on `text_source` keeps the "everything that needed OCR" selection cheap.

(`documents.ocr_confidence` still does not exist; `ocr_confidence` lives on
`document_receipt_extraction` and belongs to the receipt extractor.)
