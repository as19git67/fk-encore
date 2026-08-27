/**
 * Separator recovery for PDFs that carry their own text layer.
 *
 * `pdf-parse` renders a page by walking the text items in content-stream order,
 * starting a new line whenever an item's `transform[5]` (its baseline y) differs
 * from the previous one's, and **concatenating items on the same baseline with
 * nothing between them**. That last part loses information the PDF actually
 * contains: two items printed at opposite ends of the same line arrive fused
 * into one token.
 *
 *     12345 MusterstadtMax Mustermann        ← address block, two columns
 *     Versicherungsnummer:R-00000000-00      ← label and its value
 *     Headers:DejaVuSans Bold                ← observed on a real document
 *
 * Nothing downstream notices. `hasPoorSpacing` looks for *lost spaces inside
 * words*, and these are lost spaces *between items* — the fused token usually
 * still has a lowercase→uppercase boundary, which is one signal among four and
 * not enough on its own. So such a page wins the text-layer decision in
 * `extractPdfText` and is handed to the classifier and to `extractSender` /
 * `extractDocumentDate` in that state.
 *
 * This module supplies a `pagerender` that keeps pdf-parse's behaviour exactly
 * — same item order, same line breaks — and only inserts a separator where the
 * items' own coordinates prove there is horizontal space between them.
 *
 * ## Why it does not go further
 *
 * The obvious next step is to rebuild the page from geometry the way the OCR
 * path does (`buildVisualRows` + `splitColumnBands` in `ocr-layout.ts`), which
 * would also fix the *reading order* — content-stream order is the order the
 * producer wrote the text, not the order it appears on the page. That was built
 * and measured, and it is not safe to ship:
 *
 *   - On a two-column letterhead it worked, producing correctly paired rows
 *     (`Versicherungsnummer:   R-00000000-00`).
 *   - On a two-column journal article it destroyed the page. Merging by
 *     baseline fused the two columns of every visual line, and
 *     `splitColumnBands` did not separate them again — it is tuned on
 *     Tesseract's word boxes, which are many and narrow, and text-layer items
 *     are few and wide, so its gap statistics read completely differently. With
 *     word-level splitting to imitate that input shape the result was worse
 *     still: interleaved word salad.
 *
 * Both variants passed `shouldUseLayoutText`, because that guard compares *ink*
 * — 15782 characters either way on the article — and ink cannot see a scrambled
 * reading order. It is the same blind spot as `hasPoorSpacing`.
 *
 * Fixing the reading order therefore needs column separation that works on
 * text-layer geometry, which `splitColumnBands` currently does not provide.
 * Until it does, this module changes spacing only: it cannot reorder anything,
 * so it cannot scramble a document it does not understand.
 */

/** Master switch; `DOCUMENTS_TEXT_LAYER_SPACING=0` restores pdf-parse's own rendering. */
const TEXT_LAYER_SPACING_ENABLED =
  (process.env.DOCUMENTS_TEXT_LAYER_SPACING ?? "1") !== "0";

/**
 * A gap wider than this many times the item height reads as deliberate
 * horizontal space rather than the ordinary advance between two runs of the
 * same word. Deliberately low: the cost of a missing separator is two tokens
 * fused into a word that exists in no dictionary, while the cost of one extra
 * space is nothing at all.
 */
const SPACE_GAP_FACTOR = 0.2;

/**
 * A gap this many times the item height reads as a column break rather than a
 * word space, and gets the same three-space separator the OCR reconstruction
 * uses (`COLUMN_SEPARATOR` in `ocr-layout.ts`), so a label and a value that sit
 * far apart do not read as one sentence.
 */
const COLUMN_GAP_FACTOR = 2.2;

/** What a column-width gap becomes, matching the OCR path's separator. */
const COLUMN_SEPARATOR = "   ";

/**
 * One entry of pdf.js's `getTextContent().items`. `transform` is the 6-element
 * text matrix; indices 4 and 5 are the item's x and its *baseline* y in PDF
 * user space, whose origin is the bottom-left corner with y increasing upward.
 */
export interface PdfTextItem {
  str: string;
  width?: number;
  height?: number;
  transform: number[];
}

/** Horizontal extent of an item, falling back to the text matrix's own scale. */
function itemBox(item: PdfTextItem): { left: number; right: number; height: number } | null {
  const transform = item.transform;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const left = transform[4];
  if (!Number.isFinite(left)) return null;
  // transform[3] is the vertical scale — the font size actually in effect.
  const height =
    item.height != null && item.height > 0 ? item.height : Math.abs(transform[3]) || 1;
  // 0.5 em per character is a crude but stable mean advance for proportional
  // Latin text; it only has to be good enough to compare against a gap.
  const width =
    item.width != null && item.width > 0 ? item.width : height * 0.5 * item.str.length;
  return { left, right: left + width, height };
}

/**
 * What belongs between two items that pdf-parse would concatenate: nothing, a
 * space, or a column separator.
 *
 * Only ever *adds* characters — the two items keep their order and their
 * content. Returns "" when either item's geometry is unusable, when the text
 * already carries its own boundary space, or when the items genuinely abut,
 * which is the case pdf-parse gets right (a font or style change mid-word
 * splits one word across two items, and inserting a space there would break
 * it). Pure; unit-tested.
 */
export function separatorBetween(previous: PdfTextItem, next: PdfTextItem): string {
  if (previous.str.length === 0 || next.str.length === 0) return "";
  // The producer already supplied the boundary.
  if (/\s$/.test(previous.str) || /^\s/.test(next.str)) return "";

  const a = itemBox(previous);
  const b = itemBox(next);
  if (a == null || b == null) return "";

  const gap = b.left - a.right;
  if (!Number.isFinite(gap)) return "";
  const height = Math.max(a.height, b.height);

  // The next item starts left of where this one started, so it cannot be this
  // one continuing — a split word always advances rightward. Content-stream
  // order regularly emits a right-hand column before the left-hand one that
  // shares its baseline, and fusing those two is the worst of the observed
  // cases (`12345 MusterstadtMax Mustermann`). Separate them without claiming
  // to know which belongs first.
  if (b.left < a.left) return COLUMN_SEPARATOR;

  if (gap <= 0) return "";
  if (gap >= COLUMN_GAP_FACTOR * height) return COLUMN_SEPARATOR;
  if (gap >= SPACE_GAP_FACTOR * height) return " ";
  return "";
}

/**
 * `pdf-parse`'s page rendering with the separators restored.
 *
 * The line-breaking rule is reproduced exactly as upstream has it, including
 * its quirk of comparing baselines for *exact* equality — changing that would
 * change which items share a line, and this module deliberately does not touch
 * the arrangement.
 */
export function renderItems(
  items: readonly PdfTextItem[],
  enabled: boolean = TEXT_LAYER_SPACING_ENABLED,
): string {
  let text = "";
  let lastY: number | undefined;
  let previous: PdfTextItem | null = null;
  for (const item of items) {
    const y = item.transform?.[5];
    if (lastY === y || lastY === undefined) {
      if (previous != null && enabled) {
        text += separatorBetween(previous, item);
      }
      text += item.str;
    } else {
      text += `\n${item.str}`;
    }
    lastY = y;
    previous = item;
  }
  return text;
}

/** The subset of a pdf.js page object this module touches. */
interface PdfPageLike {
  getTextContent: (options?: unknown) => Promise<{ items: PdfTextItem[] }>;
}

/**
 * A `pagerender` for pdf-parse. Same options upstream uses, so the items arrive
 * exactly as its own renderer would see them.
 */
export async function renderPageWithSpacing(page: PdfPageLike): Promise<string> {
  const content = await page.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  return renderItems(content?.items ?? []);
}
