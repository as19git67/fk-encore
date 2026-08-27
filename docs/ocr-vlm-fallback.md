# Plan: OCR fusion with a VLM fallback

A staged plan for making the documents pipeline read the characters Tesseract
loses — `23 AUG 02` recognized as `23 aus oz` — without handing whole documents
to a language model.

Status: **plan only**. Nothing here is implemented yet. Each stage below is
meant to ship as its own PR, in order, and each one is useful on its own.

## The diagnosis

The capability that is missing is **visual recognition**, not context. Tesseract
decides each glyph from a rendered shape and a character-level language model;
it has no way to look at an ambiguous stroke again *as an image* and ask what it
most plausibly is. A vision-language model sees the pixels and interprets them
together, which is why it reads `AUG` where Tesseract reads `aus`.

Context analysis matters too, but strictly *afterwards*: it is what turns a
partly-read `23 AUG 0?` into `23.08.2002` given the rest of the page. Today's
pipeline already does a bit of that ([`metadata-extract.ts`](../documents/metadata-extract.ts))
and it cannot help when the characters themselves came out wrong.

So three levels, deliberately not mixed:

| Level | Question | Owner |
| --- | --- | --- |
| 1 — optical | which glyphs are on the page? | Tesseract, PaddleOCR, VLM |
| 2 — reconstruction | which token was most likely printed? | fusion rules, date/amount parsers, VLM |
| 3 — document meaning | what does this value mean here? | `metadata-extract.ts`, classifier |

This plan only changes levels 1 and 2. Level 3 keeps reading `extracted_text`
exactly as it does today.

## What we already have

The starting position is better than it looks:

- **Tesseract** runs per page and already emits `tsv` alongside `txt` in the
  same recognition pass, so **per-word confidence and bounding boxes cost
  nothing extra** — `parseTesseractTsv` in [`ocr-layout.ts`](../documents/ocr-layout.ts)
  parses that file today and simply drops the `conf` column.
- **PaddleOCR** is already deployed, in `receipt-ocr-service` — with box-level
  confidences, visual-row reconstruction and a variant-retry loop. It is
  reachable from the documents service over HTTP
  ([`receipt-ocr-client.ts`](../documents/receipt-ocr-client.ts)), but its
  endpoints (`/extract`, `/extract/items`, `/meter-reading`) are receipt-shaped:
  they take one photo, do receipt geometry correction, and return receipt
  fields. There is no "OCR this page image, give me boxes" endpoint.
- **llm-service** runs GGUF models through llama.cpp, in-process or via a
  `llama-server` sidecar, with runtime model switching and a model download
  manager. It is **text-only today** — no `mmproj` projector, no image content
  parts, no vision model in the catalog.

So: one new endpoint on the receipt service, one new capability on the LLM
service, and a fusion layer in between.

## The target pipeline

```
page raster (existing, from pdftoppm + ocr-preprocess)
        │
        ├── tesseract --psm 3 → txt + tsv          (existing)
        └── PaddleOCR /ocr/page → boxes + conf     (new, stage 3)
                    │
                    ▼
        ┌───────────────────────────┐
        │ ocr-resolver.ts           │  ← new, stage 2/3
        │ align boxes, compare,     │
        │ score, pick uncertain     │
        └────────┬──────────┬───────┘
                 │          │
            agreed +    disagreement /
            confident   low confidence
                 │          │
                 │   crop + margin + upscale
                 │          │
                 │   llm-service /vision/transcribe   ← new, stage 4
                 │   "transcribe exactly what is printed"
                 │          │
                 └────┬─────┘
                      ▼
              final page words → existing layout rebuild
                      ▼
                extracted_text  (unchanged contract)
```

The **contract downstream is unchanged**: the resolver produces the same word
list the layout rebuild already consumes, so `buildVisualRows`,
`splitColumnBands` and `shouldUseLayoutText` keep working untouched.

## Non-negotiable design rules

1. **Never send the whole document to the VLM.** Crops only. Fewer tokens,
   far better effective resolution on the ambiguous glyphs, fewer
   hallucinations, and a result that can be checked against the box it came
   from.
2. **The VLM transcribes, it does not correct.** The prompt asks for what is
   visibly printed and states that the OCR text is an unreliable hint. A model
   told to "fix the OCR" will happily turn `7.500` into `7.800` on a bank
   statement. Every VLM answer is additionally *validated* before it is
   accepted (see stage 5).
3. **Every stage is a flag, default off, and best-effort.** The existing
   preprocessing follows this rule (`DOCUMENTS_OCR_PREPROCESS=0` etc.) and it
   is what makes the pipeline safe to change: a missing service, a timeout, or
   a model that fails to load must leave today's output byte-identical.
4. **Bounded cost.** `DOC_SCAN_TEXT_CONCURRENCY` is 1 because Tesseract is
   CPU-bound, and a ten-page scan already costs ~23 s. A VLM pass on CPU is
   seconds per crop, so the number of crops per document is capped and the
   whole resolver runs under its own time budget, checked between crops the way
   `OCR_TIMEOUT_MS` is checked between pages.
5. **No PII in fixtures.** Test crops and expected texts are synthetic
   (`Beispielstraße 1`, `DE00 0000 0000 0000 0000 00`), per the repo rule.

## Stages

### Stage 1 — see the problem before fixing it

Nothing here changes extraction output; it makes the failure measurable.

- `parseTesseractTsv` keeps the `conf` column: `OcrWord` gains
  `confidence: number` (0..100). Every existing caller ignores it.
- A debug artifact per document, behind `DOCUMENTS_OCR_DEBUG=1`: the word list
  with boxes and confidences written next to the `_ocr` sidecar, so a bad page
  can be inspected without re-running the pipeline by hand.
- Persist which path a document took. [`document-text-extraction.md`](./document-text-extraction.md)
  already notes that `ExtractResult.source` is thrown away and there is no way
  to select "all documents that needed OCR" in SQL. Add
  `documents.text_source` (`text_layer` | `ocr` | `mixed`) plus
  `documents.ocr_mean_confidence`, so targeted re-extraction and before/after
  measurement become possible.
- A small ground-truth corpus: ~15 synthetic page crops covering the failure
  classes we care about (dates like `23 AUG 02`, amounts, IBANs, document
  numbers, small print on gray stock) with the expected string, plus a scoring
  script reporting character error rate per engine.

Ships: a measurement, a migration, and the confidence data the rest depends on.

### Stage 2 — the uncertainty detector

New module `documents/ocr-uncertainty.ts`, pure functions, unit-tested:

```ts
interface UncertainSpan {
  words: OcrWord[];          // one or more adjacent words on a visual row
  bbox: Box;                 // union, page pixel coordinates
  reasons: UncertaintyReason[];
  score: number;             // 0..1, drives ordering under the budget
}
```

Reasons, each independently testable:

- `low_confidence` — mean word confidence below `DOCUMENTS_OCR_CONF_THRESHOLD`
  (start at 70; calibrate on the stage-1 corpus).
- `implausible_charset` — a token mixing scripts or shapes that never co-occur
  in German office documents (`aus oz` next to digits, `l` inside a digit run,
  stray `|`).
- `pattern_miss` — a token that *almost* matches a known shape: a date-like run
  with one unreadable component, an IBAN of nearly the right length, an amount
  with a broken decimal group. This is where domain knowledge enters, and it is
  plain regex, not a model.
- `engine_disagreement` — added in stage 3.

Only spans on the page, never the whole page. Spans are merged when adjacent
and capped per page.

Ships on its own: even without any new engine, this gives a per-document
"suspect regions" count we can log and watch.

### Stage 3 — PaddleOCR as an independent second voice

- New endpoint in `receipt-ocr-service`: `POST /ocr/page`, taking a page image
  and returning `{ lines: [{ text, confidence, box }], full_text }` — i.e.
  `run_ocr()` exposed directly, **without** the receipt geometry correction,
  amount focus and LLM extraction that `/extract` layers on top. Roughly 30
  lines of new code around existing functions, plus schema tests.
- Client method in `receipt-ocr-client.ts`, same timeout/unavailable-error
  shape as the existing calls.
- Box alignment in the resolver: Paddle returns *line* boxes, Tesseract returns
  *word* boxes, so alignment is by geometric overlap of the span's bbox against
  Paddle lines, then a normalized string comparison (case- and
  whitespace-insensitive, confusable-folded: `0/O`, `1/l/I`, `5/S`, `2/Z`).
- Three outcomes per span: **agree** → accept, drop the span; **agree after
  confusable folding** → prefer the higher-confidence engine, keep as
  low-priority; **disagree** → `engine_disagreement`, escalate.

This is the highest value-per-risk stage: on the `23 AUG 02` class of failure,
two engines disagreeing already identifies the problem, and Paddle is often
simply right — no VLM call needed. Flag: `DOCUMENTS_OCR_SECOND_ENGINE=1`.

### Stage 4 — the VLM resolver

**Service side** (`llm-service`): a vision capability alongside the existing
text model.

- `llama-server` supports multimodal projectors (`--mmproj`), and its
  OpenAI-compatible endpoint accepts image content parts, so the *server*
  backend is the path of least resistance; the in-process `llama-cpp-python`
  path (pinned at 0.3.2) needs a chat handler per model family and should not
  be the first target. Practically: the vision model runs as its **own
  `llama-server` sidecar** — separate from the classifier — so switching or
  unloading one does not disturb the other.
- Model: a small VLM with a GGUF + `mmproj` pair. Gemma 3 (4B/12B) and the
  Qwen VL line are the realistic candidates; note that the exact generation
  names the request mentions ("Gemma 4", "Qwen 3.6") do not map onto shipping
  GGUF releases, so stage 4 starts by pinning two concrete repo/file pairs and
  measuring both against the stage-1 corpus before committing.
- Endpoint `POST /vision/transcribe`: `{ image_b64, hint?, expected_type? }` →
  `{ text, confidence, model }`, greedy decoding, tiny `max_tokens`, JSON
  response format (`_resolve_classify_response_format` already does this for
  the classifier), and a hard per-call timeout.
- The prompt states the task once and defends against invention:
  *"Transcribe exactly the text visible in this image. The OCR proposal is only
  a hint and may be wrong. Do not use meaning or expectation to invent
  characters. If a character is not legible, output `?`."*
  `expected_type` (`date` | `amount` | `iban` | `document_number` | `text`) is
  passed as a *format hint for the output*, never as permission to guess.
- Cataloged and downloadable through the existing model manager, admin-visible
  in `/models/files`, and reported in `/healthz` so an absent projector is
  diagnosable.

**Caller side** (`documents/`): crop construction, which is where the accuracy
actually comes from.

- Crop the span's bbox **plus 10–30 % margin** on each side. The margin is what
  lets the model see that the run sits under `Rechnungsdatum` — visual layout
  context, not a text prompt.
- Upscale the crop (the page is rasterized at 200 dpi; a date line is ~18 px
  tall, which is far too little for a VLM) to a target x-height, using the same
  `sharp` pipeline `ocr-preprocess.ts` already sets up.
- Encode PNG, one call per span, serially, under the budget.

Flag: `DOCUMENTS_OCR_VLM=1`, default off.

### Stage 5 — the fusion engine and its guardrails

New module `documents/ocr-resolver.ts` — the component this whole plan exists
to produce. One record per span, persisted in the stage-1 debug artifact:

```jsonc
{
  "bbox": [469, 500, 123, 18],
  "reasons": ["low_confidence", "engine_disagreement"],
  "candidates": [
    { "source": "tesseract", "text": "23 aus oz", "confidence": 0.51 },
    { "source": "paddleocr", "text": "23 AUC 02", "confidence": 0.78 },
    { "source": "vlm",       "text": "23 AUG 02", "confidence": 0.94 }
  ],
  "final_text": "23 AUG 02",
  "decision": "vlm_accepted"
}
```

Decision order, deterministic and unit-tested:

1. Two engines agree (after confusable folding) → that reading wins; no VLM.
2. VLM answer **passes validation** → VLM wins.
3. Otherwise → keep the highest-confidence OCR reading. **The pipeline never
   ends up worse than today.**

Validation is the safety-critical part, and rejects a VLM answer that:

- differs in length from both OCR candidates beyond a small ratio (a
  transcription of a crop cannot be a paragraph);
- is not plausibly derivable from the crop — edit distance to the best OCR
  candidate above a threshold *when neither engine was low-confidence*;
- changes digits in a span whose reasons did not include a digit-bearing token
  (a "date fix" must not rewrite an amount);
- contains characters outside the expected charset for `expected_type`;
- is empty, or is the prompt echoed back.

Rejections are logged with the reason. A rejection rate that climbs is the
signal that the model or prompt regressed.

Accepted spans are written back into the word list with their box preserved, so
the layout rebuild sees a normal page.

### Stage 6 — document-aware expectations (optional, later)

Once the classifier's document type is known, the expected field types for that
type can be fed into `expected_type` (a credit-card statement has a
`Rechnungsdatum` DATE and an amount MONEY). This is genuine context analysis and
it belongs *after* everything above works — it makes a good pipeline better and
would paper over a bad one.

### Stage 7 — operations

- Compose wiring for the vision sidecar (CPU and GPU images), memory notes:
  PaddleOCR + embedder + classifier + VLM on one box is a real RAM budget, and
  the vision sidecar should be startable independently.
- Timing lines extended the way the existing summary is
  (`resolver 1832ms — 7 spans, 3 paddle-resolved, 4 vlm, 1 rejected`), so the
  cost is visible in the same grep as the rest of the extraction.
- Docs: fold the result into [`document-text-extraction.md`](./document-text-extraction.md)
  and add the new variables to its configuration table.

## Configuration (all new, all default-off or no-op)

| Variable | Default | Effect |
| --- | --- | --- |
| `DOCUMENTS_OCR_DEBUG` | `0` | Write the per-document word/span debug artifact |
| `DOCUMENTS_OCR_CONF_THRESHOLD` | `70` | Mean word confidence below which a span is suspect |
| `DOCUMENTS_OCR_SECOND_ENGINE` | `0` | Run PaddleOCR as a second voice |
| `DOCUMENTS_OCR_VLM` | `0` | Allow the VLM resolver |
| `DOCUMENTS_OCR_VLM_MAX_SPANS` | `8` | Hard cap on VLM calls per document |
| `DOCUMENTS_OCR_VLM_BUDGET_MS` | `30000` | Per-document resolver budget, checked between spans |
| `DOCUMENTS_OCR_VLM_MARGIN` | `0.2` | Crop margin as a fraction of the span box |
| `VLM_SERVICE_URL` | — | Vision sidecar base URL; unset disables the stage |

## Risks and how each is contained

| Risk | Containment |
| --- | --- |
| VLM invents plausible text | Transcription-only prompt, crop-scoped, stage-5 validation, decision falls back to OCR |
| Latency on a CPU-only deployment | Spans only, hard cap and time budget, whole stage flag-off by default |
| Memory pressure from a fourth model | Separate sidecar, startable independently, GPU image sizing documented |
| Paddle and Tesseract boxes don't align | Overlap-based alignment with a confusable-folded comparison; a failed alignment degrades to "no second voice", not to a wrong merge |
| Regression on documents that work today | Every stage flagged off; the resolver only ever *replaces* spans it flagged, and only when validation passes |
| Effort spent on the wrong bottleneck | Stage 1 measures first; if the corpus shows Paddle alone closes most of the gap, stage 4 can be deferred indefinitely |

## Recommended cut

If only part of this gets built: **stages 1–3**. Confidence data, an uncertainty
detector and a second OCR engine address a large share of the `23 aus oz` class
at a fraction of the cost and risk of the VLM path — and they are exactly the
prerequisites the VLM path needs anyway.
