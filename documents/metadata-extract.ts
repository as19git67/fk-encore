/**
 * Deterministic metadata extraction applied to the classifier output in
 * `runClassify`. Pure functions — unit-tested in metadata-extract.test.ts.
 *
 * Background (#664): the LLM-extracted `sender` and `document_number` were
 * unreliable — the recipient/Bezugsperson sometimes ended up in `sender`, and
 * `document_number` frequently held a contract/insurance number rather than the
 * document's own number. These helpers post-process the LLM result with
 * high-precision rules.
 */

/** Salutations / titles dropped before comparing person names. */
const NAME_NOISE = new Set([
  "herr", "herrn", "frau", "fr", "hr", "dr", "prof", "dipl", "med", "med.", "an",
]);

function nameTokens(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-zäöüß\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NAME_NOISE.has(t));
}

/**
 * Marks an explicit "#1234"-style document-number sticker/stamp. A single
 * optional separator (space, '.', '-', ':' or '/') may sit between the '#'
 * and the digits, so "#1234", "#.1234", "# 1234" and "#-1234" all match.
 * Exported so `text-extract.ts` can check for the marker's *presence*
 * without duplicating the pattern — see the sparse-text OCR fallback there
 * for why (#892 follow-up: such markers sit in a page corner next to a logo/
 * box and are otherwise silently dropped by Tesseract's layout analysis).
 */
export const DOCUMENT_NUMBER_RE = /#[\s.\-:/]?(\d{4,})/;

/**
 * The document number is authoritative only from an explicit "#" marker in the
 * text. The LLM's free-form guess (often a contract/insurance/customer number)
 * is discarded. Returns the digits without the '#', or null. (#651)
 */
export function extractDocumentNumber(text: string): string | null {
  return text.match(DOCUMENT_NUMBER_RE)?.[1] ?? null;
}

// Date labels/anchors, most-specific first, that reliably precede a document's
// own date in German paperwork. `\w*datum` covers "Datum", "Rechnungsdatum",
// "Bescheiddatum", "Belegdatum", "Ausstellungsdatum", "Auftragsdatum", … in one
// go. `[ \t:]{0,40}` tolerates the large whitespace gap seen in OCR
// ("Rechnungsdatum                18.01.2021") while staying on the same line
// (no newline) so we never jump to a later line's unrelated date. The class is
// whitespace/colon-only, so it always stops at the first non-space — which must
// be the date's first digit — making even a large gap safe (it can't span an
// intervening field or word).
const DATE_ANCHOR_PATTERNS: readonly RegExp[] = [
  /\b\w*datum\b[ \t:]{0,80}(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/gi,
  // "Rechnung vom 18.01.2021"
  /\bvom\b[ \t:]{0,5}(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/gi,
  // German letterhead convention "Ort, TT.MM.JJJJ" (4-digit year only, to keep
  // precision — a bare 2-digit year after a word is too easily a false match).
  /\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+,[ \t]{0,3}(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g,
];

// `\w*datum` is deliberately broad, which also makes it swallow compounds that
// name a date the document is *about* rather than the date it carries. The
// contract above ("a due date, validity date or birthdate is not mistaken for
// the document date") only held for unlabelled dates; these labels made it
// through. A birthdate is the costly one — see the doctor's invoice that
// prompted this, where the patient's birth year also reached the classifier.
const NON_DOCUMENT_DATE_LABEL_RE =
  /\b(geburts|fälligkeits|faelligkeits|gültigkeits|gueltigkeits|ablauf|verfalls|sterbe)datum\b/i;

/**
 * True when `m` was anchored on a label naming someone else's date.
 *
 * The anchor patterns start at `\b\w*datum`, and `\w` is ASCII-only — in
 * "Fälligkeitsdatum" the umlaut is a word boundary, so the match begins at
 * "lligkeitsdatum" and the label is no longer recognizable in `m[0]` alone.
 * Walking back over the letters directly preceding the match restores the
 * whole word, and only that word: the walk stops at the first space, newline
 * or digit, so a "Geburtsdatum" on the line before can never suppress a real
 * "Datum" match on this one.
 */
function isNonDocumentDateMatch(text: string, m: RegExpExecArray): boolean {
  let start = m.index;
  while (start > 0 && /[A-Za-zÄÖÜäöüß]/.test(text[start - 1])) start--;
  return NON_DOCUMENT_DATE_LABEL_RE.test(text.slice(start, m.index) + m[0]);
}

/**
 * The letterhead convention with no day at all — "Wiesloch, im Mai 2009". The
 * document states a month, so the day is genuinely unknown; the first of the
 * month is the conventional reading and is what a human filing the document
 * would write. Resolved to that rather than left null, because a document with
 * no date at all drops out of every year-based view and out of the tax-year
 * derivation.
 *
 * The `im` is required, not optional. Without it the pattern degrades to
 * "<Capitalised word>, <Monat> <Jahr>", which matches ordinary prose ("Der
 * Vertrag, Mai 2009 geschlossen, …") and would put a body-text month on the
 * document. With it the match is the letterhead phrasing and little else.
 */
const DATE_ANCHOR_MONTHYEAR_PATTERNS: readonly RegExp[] = [
  /\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+,[ \t]{0,3}im[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{4})\b/g,
];

// Same anchors as above, but for German month-name dates ("8. September 2017").
// The month word is captured broadly and validated against MONTHS afterwards
// (so a non-month word never blocks a real match — the caller scans all matches
// via the /g flag). 4-digit year only. The `den` is the common
// "München, den 8. September 2017" letterhead phrasing. The letterhead pattern
// stays case-sensitive on the city's leading capital (no /i).
const DATE_ANCHOR_MONTHNAME_PATTERNS: readonly RegExp[] = [
  /\b\w*datum\b[ \t:]{0,80}(\d{1,2})\.?[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{4})\b/gi,
  /\bvom\b[ \t:]{0,5}(?:den[ \t]+)?(\d{1,2})\.?[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{4})\b/gi,
  /\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+,[ \t]{0,3}(?:den[ \t]+)?(\d{1,2})\.?[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{4})\b/g,
];

// German month names + common abbreviations → month number.
const MONTHS: Readonly<Record<string, number>> = {
  januar: 1, jan: 1, februar: 2, feb: 2, "märz": 3, maerz: 3, mrz: 3,
  april: 4, apr: 4, mai: 5, juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, oktober: 10, okt: 10,
  november: 11, nov: 11, dezember: 12, dez: 12,
};

function monthFromName(word: string): number | null {
  const key = word.trim().toLowerCase().replace(/\.$/, "");
  return MONTHS[key] ?? null;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function toIsoDate(dayStr: string, monthStr: string, yearStr: string): string | null {
  const day = Number(dayStr);
  const month = Number(monthStr);
  let year = Number(yearStr);
  if (yearStr.length === 2) {
    // strptime %y convention: 00–68 → 2000–2068, 69–99 → 1969–1999. Fits a
    // household archive that legitimately spans decades (see tax_year floor).
    year = year <= 68 ? 2000 + year : 1900 + year;
  }
  if (month < 1 || month > 12) return null;
  if (year < 1900 || year > 2100) return null;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A date label standing alone in a table cell ("Datum", "Rechnungsdatum"). */
const DATE_HEADER_CELL_RE = /^\W*\w*datum\W*$/i;

function isDocumentDateLabel(cell: string): boolean {
  return DATE_HEADER_CELL_RE.test(cell) && !NON_DOCUMENT_DATE_LABEL_RE.test(cell);
}

/** Numeric date anywhere inside a table cell. */
const CELL_DATE_RE = /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/;

/** Written-month date inside a table cell ("8. September 2017"). */
const CELL_MONTHNAME_DATE_RE = /\b(\d{1,2})\.?[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{4})\b/;

/**
 * Split one reconstructed line into its table cells. `ocr-layout.ts` renders a
 * column break as a run of spaces and a word space as a single one, so a run
 * of three or more is the column separator. Tesseract's own `txt` output (used
 * when the layout rebuild is off or unusable) separates columns by wide space
 * runs too, so this works on either rendering.
 */
function splitCells(line: string): string[] {
  return line.split(/ {3,}|\t+/).map((c) => c.trim());
}

function dateFromCell(cell: string): string | null {
  const numeric = CELL_DATE_RE.exec(cell);
  if (numeric) {
    const iso = toIsoDate(numeric[1], numeric[2], numeric[3]);
    if (iso) return iso;
  }
  const named = CELL_MONTHNAME_DATE_RE.exec(cell);
  if (named) {
    const month = monthFromName(named[2]);
    if (month != null) return toIsoDate(named[1], String(month), named[3]);
  }
  return null;
}

/**
 * Table variant of the anchored-date scan: the label is a *column header* and
 * the date sits in the row below it, not on the same line —
 *
 *     Datum      Rechnungs-Nr.   Endbetrag
 *     12.03.19   77213-9042          20,11
 *
 * which is how scanned German invoices routinely print their date. The
 * same-line patterns above cannot see this (their separator class deliberately
 * excludes newlines so they never wander into an unrelated later line).
 *
 * Matching is by cell *index*, not by character offset: the rendered column
 * widths don't track the pixel positions they came from, but the cell order
 * does. Both rows must split into the same number of cells — a mismatch means
 * a column went missing somewhere and the indices no longer line up, which is
 * exactly when a wrong value would be picked. Only a cell containing nothing
 * but the label counts as a header, so a sentence that merely mentions "Datum"
 * doesn't turn the next line into a date source.
 *
 * Runs last in `extractDocumentDate`: a date the document itself put on the
 * same line as its label is the more direct statement.
 */
function extractColumnHeaderDate(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const header = splitCells(lines[i]);
    if (!header.some(isDocumentDateLabel)) continue;
    const values = splitCells(lines[i + 1]);
    if (values.length !== header.length) continue;
    for (let k = 0; k < header.length; k++) {
      if (!isDocumentDateLabel(header[k])) continue;
      const iso = dateFromCell(values[k]);
      if (iso) return iso;
    }
  }
  return null;
}

/**
 * Cells of a line together with the column each one starts at. The index-based
 * pass above needs only the cell order; aligning a value under its header needs
 * the offset as well.
 */
function splitCellsWithOffsets(line: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const sep = /(?: {3,}|\t+)/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  const push = (raw: string, at: number) => {
    const lead = raw.length - raw.trimStart().length;
    out.push({ text: raw.trim(), start: at + lead });
  };
  while ((m = sep.exec(line)) !== null) {
    push(line.slice(pos, m.index), pos);
    pos = m.index + m[0].length;
  }
  push(line.slice(pos), pos);
  return out;
}

/** A "…datum" word anywhere inside a cell, not necessarily alone in it. */
const DATE_LABEL_WORD_RE = /\b[A-Za-zÄÖÜäöüß]*datum\b/gi;

/** As CELL_DATE_RE / CELL_MONTHNAME_DATE_RE, but scanning for every match. */
const LINE_DATE_RE = /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/g;
const LINE_MONTHNAME_DATE_RE = /\b(\d{1,2})\.?[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{4})\b/g;

// A header cell has to look like a header. Without this a sentence that merely
// contains the word "Datum" would turn the following line into a date source —
// the guard the index-based pass gets from requiring the label to be alone in
// its cell, which this pass deliberately relaxes.
const HEADER_CELL_MAX_CHARS = 32;
const HEADER_CELL_MAX_WORDS = 3;
// How far a value may sit from its header before the two stop being one column.
// OCR column offsets wobble by a few characters between the header row and the
// data row; a neighbouring column is much further away than this.
const COLUMN_ALIGN_TOLERANCE = 12;

/** Every date in `line`, with the character span it occupies. */
function datesWithOffsets(line: string): { iso: string; start: number; end: number }[] {
  const out: { iso: string; start: number; end: number }[] = [];
  for (const re of [LINE_DATE_RE, LINE_MONTHNAME_DATE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const month = re === LINE_DATE_RE ? m[2] : String(monthFromName(m[2]) ?? 0);
      const iso = toIsoDate(m[1], month, m[3]);
      if (iso) out.push({ iso, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/**
 * Second pass over the column-header layout, for the rows the index-based pass
 * cannot read. It compares *character offsets* rather than cell counts, which
 * is the information actually present in the two production shapes it exists
 * for:
 *
 *     Nummer Kunden-Nr, Datum     Seite
 *     5135897          52312 14.09.2010       I
 *
 * Here the header's own columns are not separated by wide gaps at all — three
 * labels share one cell — so no cell index corresponds to anything. The date
 * nevertheless sits directly beneath the word "Datum", which is the document
 * stating which column it belongs to. The same applies when a value cell is
 * missing and the counts no longer match: a date printed under the header is
 * evidence about that header regardless of what its neighbours did.
 *
 * Runs after the index-based pass so the stricter reading always wins.
 */
function extractAlignedColumnDate(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const values = datesWithOffsets(lines[i + 1]);
    if (values.length === 0) continue;
    for (const cell of splitCellsWithOffsets(lines[i])) {
      if (!cell.text || cell.text.length > HEADER_CELL_MAX_CHARS) continue;
      if (cell.text.split(/\s+/).length > HEADER_CELL_MAX_WORDS) continue;
      DATE_LABEL_WORD_RE.lastIndex = 0;
      let label: RegExpExecArray | null;
      while ((label = DATE_LABEL_WORD_RE.exec(cell.text)) !== null) {
        if (NON_DOCUMENT_DATE_LABEL_RE.test(label[0])) continue;
        const from = cell.start + label.index;
        const to = from + label[0].length;
        let best: { iso: string; distance: number } | null = null;
        for (const v of values) {
          const distance = v.start > to ? v.start - to : v.end < from ? from - v.end : 0;
          if (distance > COLUMN_ALIGN_TOLERANCE) continue;
          if (!best || distance < best.distance) best = { iso: v.iso, distance };
        }
        if (best) return best.iso;
      }
    }
  }
  return null;
}

/**
 * Deterministic fallback for the document date. The small model regularly
 * returns `doc_date=null` even when the date is plainly in the text
 * ("Datum: 11.08.14", "Rechnungsdatum        18.01.2021", "Datum: 09.05.2014").
 * This scans the OCR text for a date anchored to a strong German date label
 * (a "…datum" word, "vom", or the "Ort, TT.MM.JJJJ" letterhead convention),
 * both numeric ("18.01.2021") and written-month ("8. September 2017"), and
 * returns it as ISO YYYY-MM-DD. A "…datum" label used as a *column header*
 * over the date is covered too — see `extractColumnHeaderDate`.
 *
 * Only *label-anchored* dates are accepted — never just any date in the text —
 * so a due date, validity date or birthdate is not mistaken for the document
 * date. Applied as a *fallback* in runClassify: it never overrides a date the
 * LLM did produce, whose nuanced choice (salary month, invoice date, …) is
 * better. Returns null when no anchored date is found. (#date-fallback)
 */
export function extractDocumentDate(text: string): string | null {
  // Iterate all matches per pattern (not just the first): a hit on a
  // non-document label like "Geburtsdatum" must be skipped in favour of a
  // later, real one rather than abandoning the pattern.
  for (const re of DATE_ANCHOR_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isNonDocumentDateMatch(text, m)) continue;
      const iso = toIsoDate(m[1], m[2], m[3]);
      if (iso) return iso;
    }
  }
  // Written-month dates ("8. September 2017"). Iterate all matches per pattern:
  // the month word is captured broadly, so a non-month word (e.g. "Datum: sehr
  // geehrte …") must be skipped rather than aborting the scan.
  for (const re of DATE_ANCHOR_MONTHNAME_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isNonDocumentDateMatch(text, m)) continue;
      const month = monthFromName(m[2]);
      if (month == null) continue;
      const iso = toIsoDate(m[1], String(month), m[3]);
      if (iso) return iso;
    }
  }
  // Month-year letterhead ("Wiesloch, im Mai 2009") — day defaults to the 1st.
  // Runs after every day-bearing pattern: a date the document states in full is
  // always the better answer.
  for (const re of DATE_ANCHOR_MONTHYEAR_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const month = monthFromName(m[1]);
      if (month == null) continue;
      const iso = toIsoDate("1", String(month), m[2]);
      if (iso) return iso;
    }
  }
  return extractColumnHeaderDate(text) ?? extractAlignedColumnDate(text);
}

/**
 * Legal forms and institution words that mark a line as naming an organisation
 * rather than a person, a street or a subject line. Every sender strategy below
 * requires one, which is what keeps the scan from picking up the recipient
 * block: the recipient of a household's post is a household member, and their
 * name carries no legal form.
 */
const ORGANISATION_RE =
  /(?:\bg?mbh\b|\bag\b|\bkgaa\b|\bkg\b|\bohg\b|\bgbr\b|\bug\b|\bse\b|\be\.?\s?[vVgG]\.?(?:\s|$|,)|\bpartg(?:mbb)?\b|stiftung|sparkasse|volksbank|raiffeisenbank|\bbank\b|versicherung|krankenkasse|finanzamt|landratsamt|stadtwerke|stadtverwaltung|\bgemeinde\b|genossenschaft|apotheke|klinik|praxis|kanzlei|\bverlag\b|\bwerke\b)/i;

/** "Rosenstraße 19", "Beispielweg 1a", "Musterplatz 1" — a street-and-number. */
const STREET_LINE_RE = /^[^\d\n]{2,60}\s\d{1,4}\s*[a-zA-Z]?$/;

/** "12345 Musterstadt", "D-12345 Musterstadt". */
const POSTCODE_LINE_RE = /^(?:D\s*-\s*)?\d{5}\s+\p{Lu}[\p{L}.\-/ ]{1,40}$/u;

/**
 * The single-line return address printed above the address window, which German
 * business letters set in small type and join with commas:
 *
 *     MUSTER & BEISPIEL GmbH, Beispielstraße 19, D-12345 Musterstadt
 *
 * The name is everything before the first comma. This shape is unambiguous —
 * the recipient block is never comma-joined onto one line — so unlike the two
 * strategies below it does not additionally require an organisation word.
 */
const RETURN_ADDRESS_LINE_RE =
  /^(?:absender\s*:?\s*)?(.{3,80}?)\s*,\s*[^,]{3,60}\s*,\s*(?:D\s*-\s*)?\d{5}\s+\p{Lu}/iu;

/** Lines that are never a sender name, however organisation-like they look. */
const SENDER_REJECT_RE = /^(?:an|herr|herrn|frau|firma|betreff|betr\.?|seite)\b|@|^\W*$/i;

/** How far into the document a sender may be found. Letterheads are at the top. */
const SENDER_SCAN_LINES = 40;
/** A letterhead name is a name, not a paragraph. */
const SENDER_MAX_CHARS = 80;

function cleanSenderCandidate(value: string): string | null {
  const cleaned = value.replace(/\s+/g, " ").replace(/[,;·|]+$/, "").trim();
  if (cleaned.length < 3 || cleaned.length > SENDER_MAX_CHARS) return null;
  if (!/\p{L}/u.test(cleaned)) return null;
  if (SENDER_REJECT_RE.test(cleaned)) return null;
  if (STREET_LINE_RE.test(cleaned) || POSTCODE_LINE_RE.test(cleaned)) return null;
  return cleaned;
}

/**
 * Deterministic fallback for the sender, and the counterpart to
 * `extractDocumentDate`. Until this existed the sender came from the LLM alone:
 * `document_number` had the "#" rule and the date had the label scan, but a
 * model that stayed quiet about the sender left the field empty even when the
 * letterhead named the company unmistakably — a scan of the corpus after a full
 * re-classify found that to be the common case, not the exception.
 *
 * Three shapes, most distinctive first:
 *
 *   1. the comma-joined return address above the address window,
 *      "MUSTER & BEISPIEL GmbH, Beispielstraße 19, D-12345 Musterstadt";
 *   2. an address block — a name line naming an organisation, followed by a
 *      street line and a postcode line;
 *   3. a letterhead line naming an organisation, e.g. "Beispiel
 *      Finanzdienstleistungen AG" standing on its own at the top.
 *
 * Only the first `SENDER_SCAN_LINES` lines are considered, and 2 and 3 require
 * an organisation word, so the recipient block — a household member's name over
 * their own address — cannot win. `runClassify` additionally puts the result
 * through `isSubjectPersonSender`, so a household member who does trade under a
 * company name is still caught.
 *
 * Applied as a fallback only: it never overrides a sender the LLM produced.
 */
export function extractSender(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .slice(0, SENDER_SCAN_LINES);

  // 1. Return-address line.
  for (const line of lines) {
    if (line.length > 160) continue;
    const m = RETURN_ADDRESS_LINE_RE.exec(line);
    if (!m) continue;
    const candidate = cleanSenderCandidate(m[1]);
    if (candidate) return candidate;
  }

  // 2. Address block: name over street over postcode.
  for (let i = 0; i < lines.length - 2; i++) {
    if (!ORGANISATION_RE.test(lines[i])) continue;
    if (!STREET_LINE_RE.test(lines[i + 1])) continue;
    if (!POSTCODE_LINE_RE.test(lines[i + 2])) continue;
    const candidate = cleanSenderCandidate(lines[i]);
    if (candidate) return candidate;
  }

  // 3. A bare letterhead line naming an organisation.
  for (const line of lines) {
    if (!ORGANISATION_RE.test(line)) continue;
    const candidate = cleanSenderCandidate(line);
    if (candidate) return candidate;
  }

  return null;
}

/**
 * True when `sender` is essentially one of the user's Bezugspersonen — the
 * "owner/recipient extracted as sender" bug. High precision: every (de-noised)
 * sender token must belong to the person's name, and at least two tokens must
 * match (or the person's whole single-token name). So "Erika Mustermann" or
 * "Mustermann, Erika" match the person {Erika Mustermann}, but "Mustermann
 * GmbH" (extra token "gmbh") and a lone "Erika" do not.
 */
export function isSubjectPersonSender(
  sender: string | null | undefined,
  subjectPersons: readonly { full_name: string }[],
): boolean {
  const senderTokens = nameTokens(sender);
  if (senderTokens.length === 0) return false;
  for (const person of subjectPersons) {
    const personTokens = new Set(nameTokens(person.full_name));
    if (personTokens.size === 0) continue;
    if (!senderTokens.every((t) => personTokens.has(t))) continue;
    const matched = senderTokens.length;
    if (matched >= 2 || matched === personTokens.size) return true;
  }
  return false;
}

/**
 * Detect which of the user's Bezugspersonen are mentioned in the document text.
 * A person matches when every (de-noised) token of their full name appears in
 * the text — so "Erika Mustermann" matches whether the document writes
 * "Mustermann, Erika" or "Frau Erika Mustermann". Returns the matching ids.
 */
export function detectSubjectPersonIds(
  text: string,
  persons: readonly { id: number; full_name: string }[],
): number[] {
  const textTokens = new Set(nameTokens(text));
  const out: number[] = [];
  for (const person of persons) {
    const tokens = nameTokens(person.full_name);
    if (tokens.length === 0) continue;
    if (tokens.every((t) => textTokens.has(t))) out.push(person.id);
  }
  return out;
}

/** Reference-number labels → tag prefix. Order matters only for readability. */
const REFERENCE_LABELS: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: "versicherungsnr", label: String.raw`versicherungs(?:schein)?[\s-]*(?:nummer|nr\.?|konto)` },
  { prefix: "versicherungsnr", label: String.raw`policen[\s-]*(?:nummer|nr\.?)` },
  { prefix: "vertragsnr", label: String.raw`vertrags[\s-]*(?:konto(?:[\s-]*nummer)?|nummer|nr\.?)` },
  { prefix: "auftragsnr", label: String.raw`auftrags[\s-]*(?:nummer|nr\.?)` },
  { prefix: "kundennr", label: String.raw`kunden[\s-]*(?:nummer|nr\.?)` },
];

const REFERENCE_VALUE = String.raw`[:\s.]*([A-Za-z0-9][A-Za-z0-9.\/-]{3,})`;
const MAX_REFERENCE_TAGS = 6;

/**
 * Extract labelled contract/insurance/order/customer numbers from the text and
 * return them as searchable tags like "vertragsnr:12345". Conservative: a value
 * must follow a known label, contain a digit, and be 4–40 chars. These give the
 * user a search anchor that the (now '#'-only) document_number no longer holds.
 */
export function extractReferenceNumberTags(text: string): string[] {
  const tags = new Set<string>();
  for (const { prefix, label } of REFERENCE_LABELS) {
    const re = new RegExp(label + REFERENCE_VALUE, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[1]!.replace(/[.\-/]+$/, "");
      if (value.length < 4 || value.length > 40) continue;
      if (!/\d/.test(value)) continue;
      tags.add(`${prefix}:${value.toLowerCase()}`);
      if (tags.size >= MAX_REFERENCE_TAGS) return [...tags];
    }
  }
  return [...tags];
}

/**
 * Reconcile the classifier's Bezugspersonen relation tags against the
 * deterministic name detector.
 *
 * The LLM is prompted to append a person's `relation_tag` to `tags` when their
 * name appears — but even a strong model hallucinates related family members
 * (e.g. tagging a sibling or parent who is not named in the document). Person
 * identity must be deterministic: drop any relation tag the detector did not
 * confirm, and add the relation tags of every detected person. Non-person
 * ("content") tags pass through untouched. Also de-duplicates case-insensitively.
 *
 * `detectedIds` is the output of `detectSubjectPersonIds` for the same text.
 */
export function reconcileSubjectPersonTags(
  tags: readonly string[],
  subjectPersons: readonly { id: number; relation_tag: string }[],
  detectedIds: readonly number[],
): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const allRelationTags = new Set(
    subjectPersons.map((p) => norm(p.relation_tag)).filter((t) => t.length > 0),
  );
  const detected = new Set(detectedIds);
  const confirmedRelationTags = new Set(
    subjectPersons
      .filter((p) => detected.has(p.id))
      .map((p) => norm(p.relation_tag))
      .filter((t) => t.length > 0),
  );

  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const n = norm(tag);
    if (n.length === 0 || seen.has(n)) continue;
    // Drop a relation tag the deterministic detector didn't confirm.
    if (allRelationTags.has(n) && !confirmedRelationTags.has(n)) continue;
    seen.add(n);
    out.push(tag.trim());
  }
  return out;
}

/**
 * Personal deduction sections that usually require the user's own economic
 * burden.
 *
 * A document addressed to / concerning a Bezugsperson can be useful to keep
 * in the household archive, but it is not automatically a tax document for
 * the user's own income-tax return. In practice the LLM over-eagerly marks
 * third-party invoices for "mutter"/"vater" as Sonderausgaben or §35a
 * haushaltsnahe Aufwendungen.
 *
 * Deliberately not included: income sections (anlage-r, anlage-kap, ...),
 * Anlage Unterhalt, or Steuerbescheid. Those have their own semantics and can
 * legitimately refer to another person in stored paperwork.
 */
/** Exported so documents.ts can re-derive the same set for the
 *  requires_tax_review backfill when a subject person is opted in. */
export const PERSONAL_DEDUCTION_TAX_SECTION_SLUGS: readonly string[] = [
  "sonderausgaben",
  "vorsorgeaufwand",
  "anlage-av",
  "aussergewoehnliche",
  "haushaltsnahe",
  "anlage-kind",
  "anlage-energetisch",
];
const PERSONAL_DEDUCTION_SECTIONS_REQUIRING_USER_PAYMENT = new Set(
  PERSONAL_DEDUCTION_TAX_SECTION_SLUGS,
);

export interface PersonalDeductionGuardInput {
  /** Ids of matched subject persons that opted in via
   *  user_subject_persons.requires_tax_review (migration 0137) — NOT every
   *  matched subject person. The caller is responsible for filtering. */
  detectedSubjectPersonIds: readonly number[];
  taxSections: readonly { slug: string }[];
}

export interface PersonalDeductionGuardResult {
  shouldReview: boolean;
  reviewSlugs: string[];
}

/**
 * Return true when an AI tax assignment should be surfaced for human review
 * because it is a personal deduction on a document that deterministically
 * concerns a Bezugsperson opted into tax review. This is intentionally a
 * soft signal: it does not clear the tax assignment, because the user might
 * genuinely pay expenses for that person.
 *
 * The caller (runClassify) records the result in the dedicated
 * `tax_review_needed` column (migration 0136) — it is deliberately NOT folded
 * into `classification_confidence` so a confidently-classified category never
 * gets dragged into the low-confidence work-item basket by a tax question.
 *
 * The signal itself is opt-in per subject person (migration 0137): most
 * Bezugspersonen (spouse, own children) are dependents the user obviously
 * pays for, so flagging every one of them for review flooded the "zu
 * prüfen" queue. Only subject persons explicitly marked
 * requires_tax_review=true (e.g. a parent whose bills the user may not have
 * covered) reach this function at all — see document-ops.ts.
 */
export function detectSubjectPersonPersonalDeductionReview(
  input: PersonalDeductionGuardInput,
): PersonalDeductionGuardResult {
  if (input.detectedSubjectPersonIds.length === 0) {
    return { shouldReview: false, reviewSlugs: [] };
  }
  const reviewSlugs = input.taxSections
    .map((s) => s.slug.trim().toLowerCase())
    .filter((slug) => PERSONAL_DEDUCTION_SECTIONS_REQUIRING_USER_PAYMENT.has(slug));

  return {
    shouldReview: reviewSlugs.length > 0,
    reviewSlugs: Array.from(new Set(reviewSlugs)),
  };
}

// ─── Umlaut restoration ──────────────────────────────────────────────────────
//
// The local classifier regularly transliterates German umlauts in its output
// ("pruefung" instead of "prüfung", "Gebuehrenbescheid" instead of
// "Gebührenbescheid") although the prompt forbids it. A blind reverse mapping
// (ae→ä) would be wrong for words like "Michael" or "Masse", so the repair is
// dictionary-based: only spellings that literally occur in the document's own
// OCR text are restored. If the document says "Prüfung", the tag "pruefung"
// becomes "prüfung"; a word with no umlauted counterpart in the text is left
// alone.

/** Transliterate the German umlauts/ß the way the LLM does (ä→ae, …). */
function transliterateGerman(word: string): string {
  return word
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue");
}

/** Quick pre-filter: a word can only be a transliteration if it contains one
 *  of the digraphs. Keeps the per-word map lookup off the hot path. */
const TRANSLIT_DIGRAPH_RE = /ae|oe|ue|ss/i;

/**
 * Build a lookup from transliterated spelling (lowercase) → the umlauted
 * spelling (lowercase) as it appears in `sourceText`. When several distinct
 * source words collide on the same key (rare), the most frequent one wins.
 */
export function buildUmlautRestorationMap(sourceText: string): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const m of sourceText.matchAll(/\p{L}+/gu)) {
    const word = m[0]!;
    if (!/[äöüßÄÖÜ]/.test(word)) continue;
    const key = transliterateGerman(word).toLowerCase();
    const value = word.toLowerCase();
    const perKey = counts.get(key) ?? new Map<string, number>();
    perKey.set(value, (perKey.get(value) ?? 0) + 1);
    counts.set(key, perKey);
  }
  const out = new Map<string, string>();
  for (const [key, perKey] of counts) {
    const best = [...perKey.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    out.set(key, best[0]);
  }
  return out;
}

/** Re-apply the original word's casing shape to the restored spelling. */
function matchCase(original: string, restored: string): string {
  if (original === original.toUpperCase() && original.length > 1) {
    return restored.toUpperCase();
  }
  if (original[0] === original[0]!.toUpperCase()) {
    return restored.charAt(0).toUpperCase() + restored.slice(1);
  }
  return restored;
}

/**
 * Restore umlaut spellings in a free-text field (tag, title, summary) using
 * the document-derived map from `buildUmlautRestorationMap`. Word-level:
 * every letter-run whose lowercase form matches a map key is replaced,
 * preserving the original casing shape. null/empty passes through.
 */
export function restoreUmlautSpellings(
  value: string | null | undefined,
  map: ReadonlyMap<string, string>,
): string | null {
  if (!value) return value ?? null;
  if (map.size === 0) return value;
  return value.replace(/\p{L}+/gu, (word) => {
    if (!TRANSLIT_DIGRAPH_RE.test(word)) return word;
    const restored = map.get(word.toLowerCase());
    return restored ? matchCase(word, restored) : word;
  });
}
