/**
 * The OCR resolver: decide what a suspect span of a page actually says.
 *
 * `ocr-uncertainty.ts` says *where* to look. This module decides *what to
 * believe* there, from up to three readings of the same pixels:
 *
 *   1. Tesseract — the engine that produced the page.
 *   2. PaddleOCR — an independent second opinion, on pages worth the call.
 *   3. A vision model — a transcription of the crop, when the first two
 *      disagree or both read weakly.
 *
 * The decision order is fixed and, importantly, conservative:
 *
 *   two engines agree            → that reading, no model call
 *   model answer passes checks   → the model's reading
 *   otherwise                    → the best OCR reading
 *
 * The last line is the safety property the whole design rests on: **the
 * pipeline can never end up worse than it is today.** A model that is absent,
 * slow, wrong, or hallucinating results in the text the pipeline would have
 * produced anyway. That is why validation is written to reject rather than to
 * repair, and why every rejection is logged with its reason — a rejection rate
 * that climbs is the signal that a model or prompt regressed.
 *
 * The pure decision logic is separated from the crop/HTTP work so it can be
 * tested exhaustively without a service, a model, or an image.
 */

import fs from "fs";
import path from "path";
import sharp from "sharp";
import { type OcrWord } from "./ocr-layout";
import {
  confusableFold,
  patternMiss,
  spanBbox,
  type SpanBox,
  type UncertainSpan,
  type UncertaintyReason,
} from "./ocr-uncertainty";
import { locateValue, type FieldPair, type UnpairedLabel } from "./ocr-fields";
import { ocrPage, type PageOcrLine } from "./receipt-ocr-client";
import { withAiSlot } from "../ai-queue/slot-helper";
import {
  assignFields,
  transcribeCrop,
  VlmUnavailableError,
  type VlmExpectedType,
  type VlmField,
} from "./vlm-client";

console.log("[boot] documents/ocr-resolver.ts: all imports resolved");

// ─── Types ────────────────────────────────────────────────────────────────

export type CandidateSource = "tesseract" | "paddleocr" | "vlm";

export interface Candidate {
  source: CandidateSource;
  text: string;
  /** Normalized to 0..1 regardless of the engine's native scale. */
  confidence: number;
}

export type SpanDecision =
  /** Two OCR engines read the same thing; no model was asked. */
  | "ocr_agreement"
  /** The model's transcription passed validation and was taken. */
  | "vlm_accepted"
  /** The model answered, the answer failed validation, OCR was kept. */
  | "vlm_rejected"
  /** No model answer was available; the best OCR reading was kept. */
  | "ocr_kept";

export interface ResolvedSpan {
  bbox: SpanBox;
  reasons: UncertaintyReason[];
  candidates: Candidate[];
  final_text: string;
  decision: SpanDecision;
  /** Why a model answer was refused. Present only for `vlm_rejected`. */
  rejection?: string;
}

// ─── Configuration ────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? NaN : parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Both stages default OFF: this ships dark and is switched on per deployment. */
export const SECOND_ENGINE_ENABLED = () => envFlag("DOCUMENTS_OCR_SECOND_ENGINE", false);
export const VLM_ENABLED = () => envFlag("DOCUMENTS_OCR_VLM", false);

/** Hard cap on model calls per document — not per page. */
const MAX_VLM_SPANS = () => envInt("DOCUMENTS_OCR_VLM_MAX_SPANS", 8);
/** Per-document resolver budget, checked between spans like OCR_TIMEOUT_MS. */
const VLM_BUDGET_MS = () => envInt("DOCUMENTS_OCR_VLM_BUDGET_MS", 30000);
/** Crop margin as a fraction of the span box — the layout context. */
const CROP_MARGIN = () => {
  const raw = Number(process.env.DOCUMENTS_OCR_VLM_MARGIN ?? "0.2");
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.2;
};
/**
 * Crops are upscaled to this height before being sent. At 200 dpi a date line
 * is ~18 px tall, which is far below what a vision encoder can resolve — the
 * single highest-leverage number in this file.
 */
const CROP_TARGET_HEIGHT = () => envInt("DOCUMENTS_OCR_VLM_CROP_HEIGHT", 96);

// ─── Pure: comparing two engines ──────────────────────────────────────────

/** How much of `span` is covered by `line`, 0..1. */
export function overlapRatio(span: SpanBox, line: SpanBox): number {
  const width = Math.min(span.right, line.right) - Math.max(span.left, line.left);
  const height = Math.min(span.bottom, line.bottom) - Math.max(span.top, line.top);
  if (width <= 0 || height <= 0) return 0;
  const area = (span.right - span.left) * (span.bottom - span.top);
  return area > 0 ? (width * height) / area : 0;
}

/**
 * The PaddleOCR line covering a span, or null.
 *
 * Alignment is geometric because the two engines do not agree on what a unit
 * is: Tesseract returns word boxes, Paddle returns line boxes. A Paddle line
 * therefore usually contains *more* than the span — which is fine, because
 * what is compared afterwards is whether the span's reading appears in it.
 */
export function alignPaddleLine(
  span: SpanBox,
  lines: readonly PageOcrLine[],
  minOverlap = 0.5,
): PageOcrLine | null {
  let best: PageOcrLine | null = null;
  let bestRatio = minOverlap;
  for (const line of lines) {
    const ratio = overlapRatio(span, line);
    if (ratio > bestRatio) {
      best = line;
      bestRatio = ratio;
    }
  }
  return best;
}

export type Agreement = "exact" | "folded" | "differ";

/**
 * Do two readings say the same thing?
 *
 * `folded` means they differ only in characters that share a shape — `AUG` vs
 * `AUC`. Treating that as agreement is safe *because* the fold deliberately
 * keeps digits apart that no misreading conflates (see `confusableFold`): two
 * engines reading a different amount will never fold together.
 */
export function compareReadings(a: string, b: string): Agreement {
  const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
  if (normalize(a) === normalize(b)) return "exact";
  if (confusableFold(a) === confusableFold(b) && confusableFold(a).length > 0) return "folded";
  return "differ";
}

/**
 * Whether a Paddle line confirms a span's reading. The line is generally
 * longer than the span, so the test is containment of the folded skeleton
 * rather than equality.
 */
export function paddleConfirms(spanText: string, line: PageOcrLine): Agreement {
  const direct = compareReadings(spanText, line.text);
  if (direct !== "differ") return direct;
  const spanFold = confusableFold(spanText);
  const lineFold = confusableFold(line.text);
  if (spanFold.length > 0 && lineFold.includes(spanFold)) return "folded";
  return "differ";
}

/** Extract the span's own reading out of a longer Paddle line, best effort. */
export function paddleReadingFor(span: SpanBox, line: PageOcrLine): string {
  // Paddle gives no per-character geometry, so a proportional cut is the best
  // available approximation. Only used to *show* the candidate; decisions are
  // made on the full line.
  const lineWidth = line.right - line.left;
  if (lineWidth <= 0 || line.text.length === 0) return line.text;
  const from = Math.max(0, Math.floor(((span.left - line.left) / lineWidth) * line.text.length));
  const to = Math.min(
    line.text.length,
    Math.ceil(((span.right - line.left) / lineWidth) * line.text.length),
  );
  const slice = line.text.slice(from, to).trim();
  return slice.length > 0 ? slice : line.text;
}

// ─── Pure: validating a model answer ──────────────────────────────────────

/** Levenshtein distance, iterative two-row. Inputs here are short. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** Characters each expected type may legitimately contain. */
const EXPECTED_CHARSET: Record<VlmExpectedType, RegExp> = {
  date: /^[\p{L}\d\s./\-?]+$/u,
  amount: /^[\d\s.,+\-?€$]*[\d?][\d\s.,+\-?€$]*$/u,
  iban: /^[A-Z\d\s?]+$/u,
  document_number: /^[#\p{L}\d\s./\-?]+$/u,
  text: /.*/u,
};

export interface ValidationResult {
  ok: boolean;
  /** Why the answer was refused. Empty when `ok`. */
  reason: string;
}

const OK: ValidationResult = { ok: true, reason: "" };

/**
 * A German amount, formed well enough that OCR clearly read a *number* rather
 * than a digit that happens to sit in a word.
 *
 * Either a grouped thousands part or a decimal comma is required, so `23` in
 * `23 aus oz` is not an amount while `19.560.187,27` and `7.500,00` are. That
 * distinction is the whole point: the guard below must bind on numbers and stay
 * out of the way everywhere else.
 */
const AMOUNT_BODY = String.raw`-?\d{1,3}(?:\.\d{3})+(?:,\d{2})?|-?\d+,\d{2}`;
const GERMAN_AMOUNT = new RegExp(
  // Nothing digit-like may touch either end. Without this, `7.5O0,00` yields
  // `0,00` — a *wrong* value read out of the middle of a damaged number, which
  // would make the guard block the very repair it should allow.
  String.raw`(?<![\p{L}\d.,])(?:${AMOUNT_BODY})(?![\p{L}\d.,])`,
  "gu",
);

/** Every German amount in a string, as numbers. */
export function amountValues(text: string): number[] {
  return (text.match(GERMAN_AMOUNT) ?? []).map((raw) =>
    Number(raw.replace(/\./g, "").replace(",", ".")),
  );
}

/**
 * Decide whether a model's transcription may replace the OCR reading.
 *
 * Every rule here exists to stop one specific way a vision model turns a
 * transcription task back into a generation task. They are cheap, and they are
 * the reason the model is allowed anywhere near the extracted text at all.
 */
export function validateVlmAnswer(
  answer: string,
  ocrCandidates: readonly Candidate[],
  reasons: readonly UncertaintyReason[],
  expectedType: VlmExpectedType = "text",
): ValidationResult {
  const text = answer.trim();
  if (text.length === 0) return { ok: false, reason: "empty" };

  const best = bestOcrCandidate(ocrCandidates);
  const reference = best?.text.trim() ?? "";
  if (reference.length === 0) return OK;

  // A transcription of a crop cannot be prose about the crop. Models that slip
  // out of the task narrate instead of transcribing, and the narration is
  // always far longer than the line.
  const ratio = text.length / reference.length;
  if (text.length > 4 && (ratio > 2.5 || ratio < 0.4)) {
    return { ok: false, reason: `length ratio ${ratio.toFixed(2)} vs OCR` };
  }
  if (/\b(transcribe|the image|this image|I can see|appears to)\b/i.test(text)) {
    return { ok: false, reason: "answer describes the image instead of transcribing it" };
  }
  if (!EXPECTED_CHARSET[expectedType].test(text)) {
    return { ok: false, reason: `characters outside the expected ${expectedType} charset` };
  }

  // More than half the characters rewritten is not a second reading of the
  // same pixels — it is a different answer.
  const distance = Math.min(
    ...ocrCandidates.map((c) => editDistance(text.toLowerCase(), c.text.trim().toLowerCase())),
  );
  const normalized = distance / Math.max(text.length, reference.length);
  if (normalized > 0.5) {
    return { ok: false, reason: `edit distance ${normalized.toFixed(2)} from every OCR reading` };
  }

  // The digit guard. When the only thing suspect about a span is that two
  // engines disagreed, the model is arbitrating between two readings — it is
  // not licensed to produce a third one with different digits. When OCR itself
  // flagged the span as weak or implausible, it is.
  const onlyDisagreement =
    reasons.length > 0 && reasons.every((r) => r === "engine_disagreement");
  if (onlyDisagreement) {
    const agrees = ocrCandidates.some((c) => compareReadings(text, c.text) !== "differ");
    if (!agrees) {
      return {
        ok: false,
        reason: "third reading on a span whose only defect was engine disagreement",
      };
    }
  }

  // The amount guard. Where OCR already read a well-formed number, the model is
  // correcting the characters *around* it, not revaluing it — and a confidently
  // wrong amount is the most expensive thing this pipeline can produce, because
  // nothing downstream will ever question it.
  //
  // Matching any one engine's amount is enough: two engines may read different
  // numbers, and picking between them is exactly the model's job. Matching
  // none of them means it invented a third value, which is not a reading.
  const ocrAmounts = [...new Set(ocrCandidates.flatMap((c) => amountValues(c.text)))];
  if (ocrAmounts.length > 0) {
    const answered = new Set(amountValues(text));
    if (!ocrAmounts.some((value) => answered.has(value))) {
      return {
        ok: false,
        reason: `revalues the amount — OCR read ${ocrAmounts.join(" / ")}, answer has ${
          [...answered].join(" / ") || "none"
        }`,
      };
    }
  }

  return OK;
}

/**
 * The highest-scoring OCR reading, used as a *reference* — never to choose the
 * stored text. See `incumbentReading` for why.
 */
export function bestOcrCandidate(candidates: readonly Candidate[]): Candidate | null {
  const ocr = candidates.filter((c) => c.source !== "vlm");
  if (ocr.length === 0) return null;
  return ocr.reduce((a, b) => (b.confidence > a.confidence ? b : a));
}

/**
 * The reading already in the extracted text — Tesseract's.
 *
 * This used to be `bestOcrCandidate`, i.e. whichever engine reported the
 * higher confidence. Measured over 3440 spans of real paperwork, that handed
 * PaddleOCR **1194 of 1224 disagreements** (97.5 %) — not because it read
 * better, but because the two confidence scales are not comparable: Tesseract
 * averages 0.516 on flagged spans, PaddleOCR 0.953. A maximum over those two
 * numbers is a standing preference for one engine, not a decision.
 *
 * And the preference costs accuracy. Of the disagreements whose outcome can be
 * classified without a ground truth, PaddleOCR loses a diacritic 89 times and
 * gains one 25 times, truncates the line 41 times, and turns a German decimal
 * comma into a period 4 times — every measurable class pointing the same way.
 *
 * So the incumbent stands until something can actually adjudicate. That is the
 * vision stage; PaddleOCR's job is to *find* the disagreement, and it does that
 * well. The cost is real and accepted: where PaddleOCR was right and Tesseract
 * wrong, the span now keeps the worse reading — but it is flagged, which is
 * what makes the improvement reachable at all.
 */
export function incumbentReading(
  candidates: readonly Candidate[],
  fallback: string,
): string {
  return candidates.find((c) => c.source === "tesseract")?.text ?? fallback;
}

/**
 * Run one model call holding the shared `llm` slot.
 *
 * llama.cpp serves a single session, and text extraction reaches it through
 * the same server as classification. Without the queue, `DOC_SCAN_TEXT_
 * CONCURRENCY` workers would fire at it concurrently *and* bypass the
 * discipline `classify` and `embed` already submit to.
 *
 * The slot is taken per call rather than per job. Wrapping the whole
 * text_extract job — the obvious move, and what AI_MODEL_MAP would do — holds
 * the model for the entire extraction: rasterizing, rotating, Tesseract,
 * PaddleOCR, all of it, minutes on a long PDF, with llama.cpp idle throughout
 * and every other worker blocked. It would also collapse OCR to one concurrent
 * document, since each worker would be holding the only slot there is. Per
 * call, the model is held for the seconds it is actually busy.
 *
 * Priority 2 — the same as an ordinary classify job. Promoting crops above it
 * would let a queue of documents starve classification, and the calls are
 * short enough that FIFO within a priority is fair on its own.
 */
function withVlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  return withAiSlot("llm", 2, "documents:text_extract:vlm", fn);
}

// ─── Pure: the decision ───────────────────────────────────────────────────

export interface DecideOptions {
  /** The model's answer, when one was obtained. */
  vlm?: { text: string; confidence: number } | null;
  expectedType?: VlmExpectedType;
}

/**
 * Resolve one span from its candidates. Pure — the caller has already done
 * whatever I/O was needed to collect them.
 */
export function decideSpan(
  span: Pick<UncertainSpan, "bbox" | "reasons" | "text">,
  candidates: Candidate[],
  options: DecideOptions = {},
): ResolvedSpan {
  const ocr = candidates.filter((c) => c.source !== "vlm");
  const base: Omit<ResolvedSpan, "final_text" | "decision"> = {
    bbox: span.bbox,
    reasons: [...span.reasons],
    candidates,
  };
  const fallback = incumbentReading(candidates, span.text);

  // 1. Two engines agreeing settles it — and is the cheap path, since it is
  //    reached without ever calling the model.
  if (ocr.length >= 2) {
    const agreement = compareReadings(ocr[0].text, ocr[1].text);
    if (agreement !== "differ") {
      // Agreement means the two readings are equivalent, so switching to the
      // other one buys nothing and can lose something: `confusableFold` strips
      // `.`, which folds `TT.MM.JJJJ` together with PaddleOCR's `T.T.MM.JJJJ`.
      // Taking the higher-confidence variant there replaced a correct reading
      // with a wrong one on the strength of a tie.
      return { ...base, final_text: fallback, decision: "ocr_agreement" };
    }
  }

  // 2. The model, if it answered and the answer survives validation.
  const answer = options.vlm;
  if (answer && answer.text.trim().length > 0) {
    const verdict = validateVlmAnswer(answer.text, ocr, span.reasons, options.expectedType ?? "text");
    if (verdict.ok) {
      return { ...base, final_text: answer.text.trim(), decision: "vlm_accepted" };
    }
    return { ...base, final_text: fallback, decision: "vlm_rejected", rejection: verdict.reason };
  }

  // 3. Nothing that can adjudicate has spoken, so the incumbent stands and the
  //    disagreement is recorded rather than acted on.
  return { ...base, final_text: fallback, decision: "ocr_kept" };
}

/**
 * Write a resolved reading back into a visual row.
 *
 * The span's words are replaced by a single word carrying the corrected text
 * and the span's full box. That keeps the row's geometry intact — which is all
 * the layout rebuild needs, since it groups by baseline and renders gaps
 * between boxes — without inventing per-character positions the resolver does
 * not have.
 */
export function applySpanToRow(row: OcrWord[], span: SpanBox, finalText: string): OcrWord[] {
  const inside = (w: OcrWord) => w.left >= span.left && w.right <= span.right &&
    w.top >= span.top && w.bottom <= span.bottom;
  const covered = row.filter(inside);
  if (covered.length === 0) return row;

  const replacement: OcrWord = {
    text: finalText,
    left: span.left,
    top: span.top,
    right: span.right,
    bottom: span.bottom,
  };
  const out: OcrWord[] = [];
  let placed = false;
  for (const word of row) {
    if (inside(word)) {
      if (!placed) {
        out.push(replacement);
        placed = true;
      }
      continue;
    }
    out.push(word);
  }
  return out;
}

/** Map a pattern-miss shape onto what the model should be told to expect. */
export function expectedTypeFor(spanText: string): VlmExpectedType {
  return patternMiss(spanText) ?? "text";
}

// ─── Impure: crops and service calls ──────────────────────────────────────

/**
 * Cut the span out of the page, with margin, upscaled.
 *
 * The margin is the part that is easy to skip and expensive to omit: it is
 * what lets the model see that the run sits under `Rechnungsdatum`, i.e. the
 * layout context that makes a damaged date readable at all. Cropping tight to
 * the box hands over nine characters in a vacuum.
 */
export async function cropSpan(
  pageImagePath: string,
  bbox: SpanBox,
  options: { margin?: number; targetHeight?: number } = {},
): Promise<Buffer> {
  const margin = options.margin ?? CROP_MARGIN();
  const targetHeight = options.targetHeight ?? CROP_TARGET_HEIGHT();

  const image = sharp(pageImagePath, { failOn: "none" });
  const meta = await image.metadata();
  const pageWidth = meta.width ?? 0;
  const pageHeight = meta.height ?? 0;

  const width = bbox.right - bbox.left;
  const height = bbox.bottom - bbox.top;
  const padX = Math.round(width * margin);
  const padY = Math.round(height * margin);

  const left = Math.max(0, Math.round(bbox.left) - padX);
  const top = Math.max(0, Math.round(bbox.top) - padY);
  const right = Math.min(pageWidth, Math.round(bbox.right) + padX);
  const bottom = Math.min(pageHeight, Math.round(bbox.bottom) + padY);

  const cropped = image.extract({
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  });

  const cropHeight = Math.max(1, bottom - top);
  // Only ever enlarge. Shrinking a crop that is already tall enough would
  // destroy the resolution this exists to provide.
  if (cropHeight < targetHeight) {
    cropped.resize({ height: targetHeight, kernel: "lanczos3" });
  }
  return cropped.png().toBuffer();
}

export interface ResolvePageOptions {
  /** Path to the cleaned page raster Tesseract read — the same pixels. */
  pageImagePath: string;
  /** Visual rows from the layout rebuild, in reading order. */
  rows: OcrWord[][];
  /** Spans `findUncertainSpans` flagged on this page. */
  spans: UncertainSpan[];
  /** Remaining model calls for this document. */
  vlmBudget: VlmBudget;
  log?: (msg: string) => void;
}

export interface ResolvePageResult {
  rows: OcrWord[][];
  resolved: ResolvedSpan[];
  paddleMs: number;
  vlmMs: number;
}

/**
 * Resolve every flagged span on one page and return the corrected rows.
 *
 * Never throws: a service that is down, slow or missing a projector leaves the
 * page exactly as Tesseract read it.
 */
export async function resolvePage(options: ResolvePageOptions): Promise<ResolvePageResult> {
  const log = options.log ?? ((msg: string) => console.log(`[documents.ocr-resolver] ${msg}`));
  let rows = options.rows;
  const resolved: ResolvedSpan[] = [];
  let paddleMs = 0;
  let vlmMs = 0;

  if (options.spans.length === 0) return { rows, resolved, paddleMs, vlmMs };

  // ── second engine, once for the whole page ──
  let paddleLines: PageOcrLine[] = [];
  if (SECOND_ENGINE_ENABLED()) {
    const started = Date.now();
    try {
      const image = await fs.promises.readFile(options.pageImagePath);
      const result = await ocrPage(image, path.basename(options.pageImagePath));
      paddleLines = result.lines;
    } catch (err) {
      log(`second engine unavailable, continuing without it: ${(err as Error).message}`);
    }
    paddleMs = Date.now() - started;
  }

  for (const span of options.spans) {
    const candidates: Candidate[] = [
      {
        source: "tesseract",
        text: span.text,
        // Tesseract's native scale is 0..100.
        confidence: meanConfidence(span.words) / 100,
      },
    ];
    const reasons = [...span.reasons];

    const line = paddleLines.length > 0 ? alignPaddleLine(span.bbox, paddleLines) : null;
    if (line) {
      candidates.push({
        source: "paddleocr",
        text: paddleReadingFor(span.bbox, line),
        confidence: line.confidence,
      });
      if (paddleConfirms(span.text, line) === "differ" && !reasons.includes("engine_disagreement")) {
        reasons.push("engine_disagreement");
      }
    }

    // Agreement short-circuits before any model call — the cheap win.
    const provisional = decideSpan({ ...span, reasons }, candidates);
    if (provisional.decision === "ocr_agreement") {
      resolved.push(provisional);
      rows = applyToRows(rows, span.bbox, provisional.final_text);
      continue;
    }

    let answer: { text: string; confidence: number } | null = null;
    if (VLM_ENABLED() && vlmBudgetLeft(options.vlmBudget)) {
      // Cropping is local work — do it before queueing, so the slot is held
      // for the model call and nothing else.
      const crop = await cropSpan(options.pageImagePath, span.bbox).catch(() => null);
      if (crop) {
        const started = Date.now();
        try {
          const transcription = await withVlmSlot(() =>
            transcribeCrop(crop, {
              hint: span.text,
              expectedType: expectedTypeFor(span.text),
            }),
          );
          answer = { text: transcription.text, confidence: transcription.confidence };
          options.vlmBudget.calls--;
        } catch (err) {
          // A missing projector, a busy worker, a timeout — all the same to us.
          if (!(err instanceof VlmUnavailableError)) {
            log(`vlm call failed: ${(err as Error).message}`);
          }
        }
        const elapsed = Date.now() - started;
        vlmMs += elapsed;
        options.vlmBudget.spentMs += elapsed;
      }
    }

    const decision = decideSpan({ ...span, reasons }, candidates, {
      vlm: answer,
      expectedType: expectedTypeFor(span.text),
    });
    resolved.push(decision);
    if (decision.final_text !== span.text) {
      rows = applyToRows(rows, span.bbox, decision.final_text);
    }
    if (decision.decision === "vlm_rejected") {
      log(`rejected model reading ${JSON.stringify(decision.candidates.at(-1)?.text)} — ${decision.rejection}`);
    }
  }

  return { rows, resolved, paddleMs, vlmMs };
}

function applyToRows(rows: OcrWord[][], bbox: SpanBox, finalText: string): OcrWord[][] {
  return rows.map((row) => {
    const box = row.length > 0 ? spanBbox(row) : null;
    if (!box || overlapRatio(bbox, box) <= 0) return row;
    return applySpanToRow(row, bbox, finalText);
  });
}

function meanConfidence(words: readonly OcrWord[]): number {
  const measured = words.map((w) => w.confidence).filter((c): c is number => c !== undefined);
  if (measured.length === 0) return 100;
  return measured.reduce((a, b) => a + b, 0) / measured.length;
}

// ─── Reporting ────────────────────────────────────────────────────────────

export interface ResolverTally {
  spans: number;
  agreement: number;
  vlmAccepted: number;
  vlmRejected: number;
  /** Kept because the two engines read the span differently. */
  keptDisagreement: number;
  /**
   * Kept because no second reading covered the span at all — PaddleOCR
   * detected nothing there, or its line boxes did not align.
   */
  keptNoSecondReading: number;
}

export function newResolverTally(): ResolverTally {
  return {
    spans: 0,
    agreement: 0,
    vlmAccepted: 0,
    vlmRejected: 0,
    keptDisagreement: 0,
    keptNoSecondReading: 0,
  };
}

/**
 * Accumulate a page's decisions into a per-document tally.
 *
 * The split inside `ocr_kept` is the point. A first production run reported
 * 182 spans with 132 of them "ocr kept", and that number could not be acted
 * on: it conflates *the engines disagreed* — a real signal, and exactly what
 * the vision stage exists for — with *there was no second reading at all*,
 * which means the second engine contributed nothing and the alignment or
 * PaddleOCR's own detection is what needs looking at. Those two readings of
 * the same number lead to opposite conclusions, so they are counted apart.
 */
export function tallyDecisions(
  spans: readonly ResolvedSpan[],
  into: ResolverTally = newResolverTally(),
): ResolverTally {
  for (const span of spans) {
    into.spans++;
    const hadSecondReading = span.candidates.some((c) => c.source === "paddleocr");
    switch (span.decision) {
      case "ocr_agreement":
        into.agreement++;
        break;
      case "vlm_accepted":
        into.vlmAccepted++;
        break;
      case "vlm_rejected":
        into.vlmRejected++;
        break;
      default:
        if (hadSecondReading) into.keptDisagreement++;
        else into.keptNoSecondReading++;
    }
  }
  return into;
}

/** The summary line. Empty when nothing was flagged on the document. */
export function formatResolverTally(tally: ResolverTally): string {
  return (
    `resolver: ${tally.spans} span(s) — ` +
    `${tally.agreement} engine agreement, ` +
    `${tally.vlmAccepted} vlm accepted, ` +
    `${tally.vlmRejected} vlm rejected, ` +
    `${tally.keptDisagreement + tally.keptNoSecondReading} ocr kept ` +
    `(${tally.keptDisagreement} engine disagreement, ` +
    `${tally.keptNoSecondReading} no second reading)`
  );
}

// ─── Whole-page field assignment ──────────────────────────────────────────
//
// The other failure mode: the characters read fine, but the *pairing* of
// labels to values cannot be derived from the geometry. A crop cannot answer
// that — the layout is exactly what a crop removes — so this is the one place
// a whole page goes to the model.

/**
 * At least this many typed labels must have found no value. One unpaired label
 * is usually a false positive: a `vom` inside prose, a table column empty on
 * this page. Two independent failures are not.
 */
const FIELD_VLM_MIN_UNPAIRED = () => envInt("DOCUMENTS_OCR_FIELD_VLM_MIN_UNPAIRED", 2);

/**
 * …and they must be at least this share of the page's typed labels. Below it,
 * one field slipped; above it, the positional assumptions do not hold for this
 * layout at all — which is the only situation where a whole page is worth its
 * cost.
 */
const FIELD_VLM_MIN_RATIO = () => {
  const raw = Number(process.env.DOCUMENTS_OCR_FIELD_VLM_MIN_RATIO ?? "0.5");
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
};

/** Whole-page calls allowed per document — its own budget, not the crops'. */
const FIELD_VLM_MAX_PAGES = () => envInt("DOCUMENTS_OCR_FIELD_VLM_MAX_PAGES", 1);

/**
 * Longest edge the page is scaled to before it is sent. A 200-dpi A4 page is
 * ~2480px wide, far more than a vision encoder uses and a large prefill cost
 * for detail that does not survive its patching anyway.
 */
const FIELD_VLM_MAX_PX = () => envInt("DOCUMENTS_OCR_FIELD_VLM_MAX_PX", 1600);

export interface FieldAssignmentDecision {
  ask: boolean;
  /** Why not, for the log. Empty when `ask`. */
  reason: string;
}

/**
 * Whether this page's pairing failed badly enough to be worth a whole-page
 * look. Pure, so the threshold can be reasoned about without a model.
 *
 * `hasUnresolvedSpan` is the precondition that keeps the call off clean pages:
 * a better assignment buys nothing where nothing is in doubt — the text is
 * already right, and the pairing would only be used to judge values that need
 * no judging.
 */
export function shouldAskForFieldAssignment(input: {
  pairs: readonly FieldPair[];
  unpaired: readonly UnpairedLabel[];
  hasUnresolvedSpan: boolean;
  pagesUsed: number;
}): FieldAssignmentDecision {
  if (!VLM_ENABLED()) return { ask: false, reason: "vlm disabled" };
  if (input.pagesUsed >= FIELD_VLM_MAX_PAGES()) {
    return { ask: false, reason: "per-document page budget spent" };
  }
  if (!input.hasUnresolvedSpan) {
    return { ask: false, reason: "nothing on the page is in doubt" };
  }
  const unpaired = input.unpaired.length;
  if (unpaired < FIELD_VLM_MIN_UNPAIRED()) {
    return { ask: false, reason: `only ${unpaired} unpaired label(s)` };
  }
  const typed = input.pairs.length + unpaired;
  const ratio = typed > 0 ? unpaired / typed : 0;
  if (ratio < FIELD_VLM_MIN_RATIO()) {
    return { ask: false, reason: `${(ratio * 100).toFixed(0)}% of labels unpaired` };
  }
  return { ask: true, reason: "" };
}

export interface AssignedField {
  label: string;
  value: string;
  words: OcrWord[];
  bbox: SpanBox;
  expectedType: VlmExpectedType;
}

export interface FieldAssignmentResult {
  accepted: AssignedField[];
  /** Values the model returned that are not on the page. */
  rejected: Array<{ label: string; value: string; reason: string }>;
}

/**
 * Keep only the fields whose value is actually printed on the page.
 *
 * This is the whole safety argument for handing over a page. The model may
 * re-assign what OCR read; it may not add to it. A value that cannot be
 * located among the words is one the model produced rather than found, and is
 * dropped — no matter how plausible it looks, and especially when it looks
 * plausible.
 */
export function validateFieldAssignment(
  fields: readonly VlmField[],
  rows: OcrWord[][],
  unpaired: readonly UnpairedLabel[],
): FieldAssignmentResult {
  const expected = new Map(unpaired.map((u) => [u.label.trim().toLowerCase(), u.expectedType]));
  const accepted: AssignedField[] = [];
  const rejected: FieldAssignmentResult["rejected"] = [];
  const claimed = new Set<string>();

  for (const field of fields) {
    const key = field.label.trim().toLowerCase();
    const type = expected.get(key);
    if (type === undefined) {
      rejected.push({ ...field, reason: "label was not one of the unpaired ones" });
      continue;
    }
    if (claimed.has(key)) {
      rejected.push({ ...field, reason: "label already assigned" });
      continue;
    }
    const words = locateValue(rows, field.value);
    if (words === null) {
      rejected.push({ ...field, reason: "value is not printed anywhere on the page" });
      continue;
    }
    claimed.add(key);
    accepted.push({
      label: field.label,
      // The page's own reading wins over the model's rendering of it: the
      // words are what the rest of the pipeline works with, and taking the
      // model's string here would smuggle its transcription in through a call
      // that is only supposed to decide assignment.
      value: words.map((w) => w.text).join(" "),
      words,
      bbox: spanBbox(words),
      expectedType: type,
    });
  }
  return { accepted, rejected };
}

/**
 * Scale a page down before sending it, and encode it.
 *
 * Only ever shrinks: a page smaller than the cap is already cheap, and
 * enlarging it would add prefill cost for no additional detail.
 */
export async function pageImageForAssignment(
  pageImagePath: string,
  maxPx = FIELD_VLM_MAX_PX(),
): Promise<Buffer> {
  return sharp(pageImagePath, { failOn: "none" })
    .resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

/**
 * Ask the model to assign the unpaired labels, and keep what survives
 * validation. Never throws: a service that is down leaves the pairing as the
 * geometry produced it.
 */
export async function resolveFieldAssignment(options: {
  pageImagePath: string;
  rows: OcrWord[][];
  unpaired: readonly UnpairedLabel[];
  log: (msg: string) => void;
}): Promise<FieldAssignmentResult> {
  const empty: FieldAssignmentResult = { accepted: [], rejected: [] };
  try {
    // Downscaling the page happens outside the slot; only the model call is
    // inside it. A whole page costs a multiple of a crop, so holding the slot
    // across the resize would block the queue on image work.
    const image = await pageImageForAssignment(options.pageImagePath);
    const answer = await withVlmSlot(() =>
      assignFields(
        image,
        options.unpaired.map((u) => u.label),
      ),
    );
    const result = validateFieldAssignment(answer.fields, options.rows, options.unpaired);
    for (const drop of result.rejected) {
      options.log(
        `rejected field ${JSON.stringify(drop.label)} = ${JSON.stringify(drop.value)} — ${drop.reason}`,
      );
    }
    return result;
  } catch (err) {
    if (!(err instanceof VlmUnavailableError)) {
      options.log(`field assignment failed: ${(err as Error).message}`);
    }
    return empty;
  }
}

/** Fresh per-document budget for the model calls. */
/**
 * The per-document allowance for model work.
 *
 * `spentMs` counts time the model was *working*, not wall-clock since the
 * document started. The difference matters because every call now queues for
 * the shared llama.cpp session: with a wall-clock deadline, a document that
 * waited 40 s behind other work would arrive at its first crop with the whole
 * 30 s budget already gone and silently do no vision at all — the resolver
 * would look switched off rather than starved.
 *
 * Wall-clock is still bounded, one level up: DOCUMENTS_OCR_TIMEOUT_MS stops
 * the page loop, and a document that runs past it is truncated and says so.
 */
export function newVlmBudget(): VlmBudget {
  return { calls: MAX_VLM_SPANS(), budgetMs: VLM_BUDGET_MS(), spentMs: 0 };
}

/** Calls and model-time left for one document. Mutated as they are spent. */
export interface VlmBudget {
  calls: number;
  budgetMs: number;
  spentMs: number;
}

/** Is there anything left to spend? */
export function vlmBudgetLeft(budget: VlmBudget): boolean {
  return budget.calls > 0 && budget.spentMs < budget.budgetMs;
}
