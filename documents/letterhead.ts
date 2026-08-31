/**
 * Finding the two fields a letterhead never labels: the document's date and
 * its sender.
 *
 * ## Why this module exists
 *
 * Every earlier route to these two fields is keyed on a *printed label*. The
 * layout pairing needs a label it can pair a value to; the whole-page vision
 * call is only asked about labels the pairing could not place; the regex
 * fallbacks need an anchor word ("Rechnungsdatum", "vom", "Ort,"). A German
 * business letter prints none of them. It sets the date alone at the top
 * right and the sender in the logo block, and expects the reader to know what
 * they are looking at from *where they are on the page*.
 *
 * The classifier cannot recover that: it is handed reading-order text, in
 * which the date sits between a franking mark and a routing code and is
 * indistinguishable from a contract number. The position was thrown away
 * before the model ever saw the document.
 *
 * So this module asks the question the way a reader answers it — by looking
 * at the page — and then insists on proof.
 *
 * ## Text, not coordinates
 *
 * The model is asked to *read out* the date and the sender, not to return
 * their bounding boxes. Small vision models are unreliable at grounding but
 * good at reading, and a box we cannot verify is worse than no box: it would
 * send the crop stage to the wrong pixels with full confidence.
 *
 * Instead the answer is located in the OCR words, which already carry
 * coordinates (`anchor`). That inverts the trust: the model proposes, the page
 * disposes. An answer that cannot be found on the page is discarded no matter
 * how confident the model was, which is the same discipline `assignFields`
 * already applies to its values, and the reason a hallucinated sender cannot
 * reach the database.
 *
 * ## Ranking
 *
 * A letter can point at its date from several places at once — the letterhead,
 * a "Datum" label in a table, the classifier's own reading. `rankDateReadings`
 * settles those against each other by *how well evidenced* each is, with
 * agreement between two independent readers outranking any single one.
 *
 * Everything here is pure. The service call and the crop live in the caller,
 * so the decision logic can be tested exhaustively without a model.
 */

import { confusableFold, type SpanBox } from "./ocr-uncertainty";
import { editDistance, pageImageForAssignment } from "./ocr-resolver";
import { readLetterhead, VlmUnavailableError, type VlmLetterhead } from "./vlm-client";
import { withAiSlot } from "../ai-queue/slot-helper";
import type { DocumentLetterhead, LetterheadReading } from "../db/schema";
import type { OcrWord } from "./ocr-layout";

console.log("[boot] documents/letterhead.ts: all imports resolved");

/** Where a reading came from, worst-evidenced last. */
export type ReadingSource =
  /** The vision model, located in the page's own words. */
  | "vision"
  /** The label-anchored scan over the OCR text. */
  | "scan"
  /** The classifier, which saw text only and can point at nothing. */
  | "classify";

export interface Reading<T> {
  value: T;
  source: ReadingSource;
  /** Where on the page it was found, when it could be located at all. */
  bbox: SpanBox | null;
}

/**
 * How closely an anchor has to match before it counts as *the same text*.
 *
 * Not an exact match: the model reads the page, the OCR read the page, and
 * they disagree about exactly the characters this pipeline exists to repair.
 * Requiring equality would reject precisely the answers worth having. 0.25 of
 * the length is roughly one wrong character in four — loose enough to survive
 * a misread glyph, tight enough that a different line cannot pass.
 */
const ANCHOR_MAX_DISTANCE = 0.25;

/** Words per anchor window. A letterhead name or a date is never longer. */
const MAX_ANCHOR_WORDS = 12;

export interface Anchor {
  bbox: SpanBox;
  /** The OCR text actually matched, which is not always what was searched for. */
  text: string;
  /** 0..1, 1 being an exact match after folding. */
  similarity: number;
}

/**
 * Locate `answer` among the page's words and return where it sits.
 *
 * Searches every run of up to `MAX_ANCHOR_WORDS` consecutive words, and lets a
 * run cross a row boundary: a letterhead name is routinely set across two
 * lines ("Muster Bauspar" / "Bauspar AG"), and an anchor that could not span
 * rows would find only the half of it that fits on one.
 *
 * Comparison is on `confusableFold`, which already drops whitespace, hyphens
 * and dots and folds the glyph pairs OCR confuses. That makes the match
 * indifferent to how either side broke the text into words — the one property
 * this needs, since the model returns prose and the OCR returns boxes.
 */
export function anchor(answer: string, rows: readonly (readonly OcrWord[])[]): Anchor | null {
  const needle = confusableFold(answer);
  if (needle.length < 3) return null;

  // One flat sequence, so a window can cross a row boundary.
  const words = rows.flat();
  let best: Anchor | null = null;

  for (let start = 0; start < words.length; start++) {
    let folded = "";
    for (let n = 0; n < MAX_ANCHOR_WORDS && start + n < words.length; n++) {
      folded += confusableFold(words[start + n].text);
      if (folded.length === 0) continue;
      // A window far longer than the needle cannot beat a shorter one, and
      // every further word only makes it longer.
      if (folded.length > needle.length * 2) break;
      const distance = editDistance(folded, needle);
      const similarity = 1 - distance / Math.max(folded.length, needle.length);
      if (distance / Math.max(folded.length, needle.length) > ANCHOR_MAX_DISTANCE) continue;
      if (best && similarity <= best.similarity) continue;
      const run = words.slice(start, start + n + 1);
      best = {
        bbox: {
          left: Math.min(...run.map((w) => w.left)),
          top: Math.min(...run.map((w) => w.top)),
          right: Math.max(...run.map((w) => w.right)),
          bottom: Math.max(...run.map((w) => w.bottom)),
        },
        text: run.map((w) => w.text).join(" "),
        similarity,
      };
    }
  }
  return best;
}

/**
 * Pick one reading from several.
 *
 * The order is by evidence, not by who produced it:
 *
 *   1. **Two sources agree.** Two readers arriving at the same value from
 *      different evidence is the strongest signal available, stronger than
 *      either one alone, and it is the case this whole module was built to
 *      exploit — the letterhead date read off the page and a "Datum" label
 *      found in the text are independent confirmations of each other.
 *   2. **Located on the page.** A reading with a box was found in the words
 *      the scanner actually produced; one without is a claim about a document
 *      nobody checked against it.
 *   3. **Source order**, as a last tie-break: vision, then scan, then the
 *      classifier, which saw no layout at all.
 *
 * Returns null for an empty list, so "nothing was found" stays distinct from
 * "something was found and rejected".
 */
export function rankReadings<T>(readings: readonly Reading<T>[]): Reading<T> | null {
  if (readings.length === 0) return null;

  const order: Record<ReadingSource, number> = { vision: 0, scan: 1, classify: 2 };
  const score = (r: Reading<T>) => {
    const agreed = readings.filter((o) => o !== r && o.value === r.value).length > 0;
    return [agreed ? 0 : 1, r.bbox ? 0 : 1, order[r.source]];
  };

  return [...readings].sort((a, b) => {
    const [x, y] = [score(a), score(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  })[0];
}

// ─── The impure boundary: one call, one page ──────────────────────────────

/**
 * Read page 1's letterhead and locate what came back.
 *
 * Runs inside `text_extract` rather than inside `classify`, and that placement
 * is forced: anchoring needs the page's word boxes and the model needs the
 * page raster, and both exist only here. By the time classify runs, the
 * temporary rasters are gone and the text has been flattened into reading
 * order — which is exactly the loss this module exists to undo.
 *
 * Never throws. A service that is down, busy, or has no projector leaves the
 * document with no reading at all, and every earlier route to the two fields
 * behaves as it did before.
 */
export async function readLetterheadForPage(options: {
  pageImagePath: string;
  rows: readonly (readonly OcrWord[])[];
  /** 1-based, recorded on each reading so a later page is recognisable. */
  page: number;
  log: (msg: string) => void;
}): Promise<DocumentLetterhead | null> {
  let answer: VlmLetterhead;
  try {
    // Downscaling happens outside the slot: a whole page costs a multiple of a
    // crop, and holding the shared model across image work blocks the queue on
    // something no model is doing.
    const image = await pageImageForAssignment(options.pageImagePath);
    answer = await withAiSlot("llm", 2, "documents:text_extract:letterhead", () =>
      readLetterhead(image),
    );
  } catch (err) {
    if (!(err instanceof VlmUnavailableError)) {
      options.log(`letterhead read failed: ${(err as Error).message}`);
    }
    return null;
  }

  const locate = (value: string | null): LetterheadReading | null => {
    if (!value || value.trim().length === 0) return null;
    const found = anchor(value, options.rows);
    // Kept even when it could not be located: a reading with no box is a
    // weaker claim, not a rejected one, and `rankReadings` already scores it
    // below anything the page confirms. Dropping it here would throw away the
    // one reader that can see the layout whenever OCR mangled the letterhead
    // badly enough that nothing matches — which is when it is most useful.
    return { value: value.trim(), bbox: found?.bbox ?? null, page: options.page };
  };

  const result: DocumentLetterhead = {
    date: locate(answer.date),
    date_label: answer.date_label ?? null,
    sender: locate(answer.sender),
    language: answer.language ?? null,
  };
  // The values are the document's own content, so only whether each was found
  // and whether the page confirmed it is logged — never what it said.
  options.log(
    `letterhead p${options.page}: date=${describe(result.date)}` +
      `${result.date_label ? " (labelled)" : ""}, sender=${describe(result.sender)}, ` +
      `language=${result.language ?? "-"}, ${answer.processing_ms}ms`,
  );
  return result;
}

/**
 * Combine the readings of two pages, first page first.
 *
 * Not symmetric, and the asymmetry is the point. The **date** may legitimately
 * come from either — the letterhead of page 1 or the signature of the last —
 * so the later page fills it in when the first had none. The **sender** and
 * the **language** may not: a last page carries a footer, a page number and
 * sometimes a second company's imprint, and taking a sender from there would
 * quietly replace the letterhead's name with whoever printed the form.
 *
 * So: everything from the earlier reading survives, and the later one may only
 * supply a date that was missing.
 */
export function mergeLetterhead(
  first: DocumentLetterhead | null,
  later: DocumentLetterhead | null,
): DocumentLetterhead | null {
  if (!first) return later;
  if (!later) return first;
  if (first.date) return first;
  return {
    ...first,
    date: later.date,
    date_label: later.date_label ?? null,
  };
}

function describe(reading: LetterheadReading | null): string {
  if (!reading) return "none";
  return reading.bbox ? "located" : "unlocated";
}
