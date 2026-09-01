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
  /\b(geburts|fälligkeits|faelligkeits|gültigkeits|gueltigkeits|ablauf|verfalls|sterbe)datum\b|\b(?:date\s+of\s+birth|birth\s*date|due\s+date|expiry\s+date|expiration\s+date)\b/i;

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
/**
 * Qualifiers that turn a bare English "date" into someone else's date.
 *
 * German compounds them into one word ("Fälligkeitsdatum"), which the
 * letter-only walk below recovers. English writes them separately ("due
 * date"), so the walk stops at the space and sees only "date" — the guard
 * would pass and a payment deadline would be filed as the document's date.
 */
const EN_DATE_QUALIFIER_RE =
  /\b(?:due|birth|expiry|expiration|maturity|valid|effective|start|end|payment|delivery)\s+$/i;

function isNonDocumentDateMatch(text: string, m: RegExpExecArray): boolean {
  let start = m.index;
  while (start > 0 && /[A-Za-zÄÖÜäöüß]/.test(text[start - 1])) start--;
  if (NON_DOCUMENT_DATE_LABEL_RE.test(text.slice(start, m.index) + m[0])) return true;
  return EN_DATE_QUALIFIER_RE.test(text.slice(Math.max(0, m.index - 24), m.index));
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
//
// The two LABELLED patterns take a two- or four-digit year; the unanchored
// "Ort," one still insists on four. The label is what makes the difference — a
// bare two-digit year after a city name is too easily a house number or a
// reference, while nothing follows "Rechnungsdatum" but the date.
// The month word is captured broadly and validated against MONTHS afterwards
// (so a non-month word never blocks a real match — the caller scans all matches
// via the /g flag). 4-digit year only. The `den` is the common
// "München, den 8. September 2017" letterhead phrasing. The letterhead pattern
// stays case-sensitive on the city's leading capital (no /i).
// English date labels, for the paperwork a household archive collects from
// abroad. Kept to labels that name the document's OWN date; a bare "date" is
// included because on such forms it is nearly always the field caption, and
// the same NON_DOCUMENT_DATE_LABEL guard that protects "...datum" does not
// apply — an English "date of birth" is caught by its own entry below.
const EN_DATE_LABEL = String.raw`(?:date\s+of\s+issue|issue\s+date|invoice\s+date|statement\s+date|entered\s+date|date)`;

// "Lieferdatum   2014-11-17", "Datum: 2014-11-17" — an ISO date behind a
// label. Unambiguous by construction: a four-digit year cannot be a day or a
// month, so no convention is needed and the order cannot be misread.
//
// `normalizeDocumentDate` has read this shape from the start, so until now the
// two readers disagreed about the same printed characters: a delivery note
// whose "Lieferdatum" is written the ISO way had a date the vision path could
// have used and the text scan could not see.
const DATE_ANCHOR_ISO_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:\w*datum|${EN_DATE_LABEL})\b[ \t:]{0,80}(\d{4})-(\d{2})-(\d{2})\b`,
    "gi",
  ),
  /\bvom\b[ \t:]{0,5}(\d{4})-(\d{2})-(\d{2})\b/gi,
];

// "Date of issue   August 23, 2026" — a spelled-out month, then the day. The
// order is fixed by the month being a word, so this needs no convention.
const DATE_ANCHOR_MONTHDAY_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b${EN_DATE_LABEL}\b[ \t:]{0,80}([A-Za-z]{3,})\.?[ \t]+(\d{1,2})(?:st|nd|rd|th)?,?[ \t]+(\d{4})\b`,
    "gi",
  ),
];

// "12-MAY-2013", with or without a label in front of or behind it. Also
// unambiguous: the month is spelled out.
const DATE_ANCHOR_DAYMONTH_HYPHEN_PATTERNS: readonly RegExp[] = [
  /\b(\d{1,2})-([A-Za-z]{3,})-(\d{4})\b/g,
];

// Numeric dates separated by a slash or a hyphen. THE ONE SHAPE WHOSE READING
// IS NOT SETTLED BY ITS CHARACTERS: 03/04/2013 is 3 April in most of Europe
// and 4 March in the US, so the caller's `convention` decides which capture is
// the day. Every other pattern in this file is order-safe.
//
// Only ever matched next to a label. A bare slash date in running text is as
// likely to be a fraction, a reference or a period as a date, and this is
// precisely the shape where guessing wrong is silent.
const DATE_ANCHOR_AMBIGUOUS_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:\w*datum|${EN_DATE_LABEL})\b[ \t:]{0,80}(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b`,
    "gi",
  ),
  /\bvom\b[ \t:]{0,5}(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/gi,
  // The "Ort, TT/MM/JJJJ" letterhead, which the dotted patterns have always
  // covered but the slash form never did. Four-digit year only, exactly as the
  // dotted one: a two-digit year after a word is too easily a false match.
  /\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+,[ \t]{0,3}(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g,
];

const DATE_ANCHOR_MONTHNAME_PATTERNS: readonly RegExp[] = [
  /\b\w*datum\b[ \t:]{0,80}(\d{1,2})\.?[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{2,4})\b/gi,
  /\bvom\b[ \t:]{0,5}(?:den[ \t]+)?(\d{1,2})\.?[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{2,4})\b/gi,
  /\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+,[ \t]{0,3}(?:den[ \t]+)?(\d{1,2})\.?[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{4})\b/g,
];

// German and English month names + common abbreviations → month number.
//
// English earns its place because a household archive is not monolingual — an
// invoice from a US service, a bank confirmation, an insurance certificate.
// The two sets never collide: where a spelling is shared ("jun", "jul", "sep",
// "nov", "august", "september", "november") both languages mean the same
// month, so one table can serve both without knowing which language it is
// reading.
//
// A spelled-out month is also the only date form that cannot be misread as to
// its ORDER — which is what makes "August 23, 2026" and "12-MAY-2013" safe to
// accept unconditionally, while the numeric forms need `inferDateConvention`.
const MONTHS: Readonly<Record<string, number>> = {
  januar: 1, jan: 1, january: 1,
  februar: 2, feb: 2, february: 2,
  "märz": 3, maerz: 3, mrz: 3, mar: 3, march: 3,
  april: 4, apr: 4,
  mai: 5, may: 5,
  juni: 6, jun: 6, june: 6,
  juli: 7, jul: 7, july: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, okt: 10, oct: 10, october: 10,
  november: 11, nov: 11,
  dezember: 12, dez: 12, dec: 12, december: 12,
};

function monthFromName(word: string): number | null {
  const key = word.trim().toLowerCase().replace(/\.$/, "");
  return MONTHS[key] ?? null;
}

/**
 * Which number comes first in a numeric date whose separator is a slash or a
 * hyphen: `03/04/2013` is 3 April to most of Europe and 4 March to the US.
 *
 * Dotted dates are deliberately NOT covered — `03.04.2013` is day-first
 * everywhere it occurs, nobody writes an American date with dots — which is
 * why this convention question is entirely new surface rather than a
 * reinterpretation of anything already stored.
 */
export type DateConvention = "dmy" | "mdy";

/** A slash- or hyphen-separated numeric date, wherever it appears. */
const AMBIGUOUS_NUMERIC_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g;

/**
 * Decide which way round to read this document's numeric dates.
 *
 * The evidence is ranked, and the first rank is the one that matters:
 *
 * 1. **The document's own numbers.** A single date in it with a first
 *    component above 12 proves day-first for the whole document; one with a
 *    second component above 12 proves month-first. This is decisive, it needs
 *    no model, and it is *language-independent* — which is exactly what the
 *    counter-example requires: an Apple invoice is written in English and
 *    dated in German, and any rule keyed on language alone reads its dates a
 *    month wrong. When both kinds appear (a mixed-format document, or a
 *    misread digit) the majority wins, and a tie falls through to the next
 *    rank rather than guessing.
 * 2. **The document's language**, as the vision model reported it. Weaker: it
 *    describes the prose, and the prose does not always date the document.
 * 3. **Day-first**, the default, because that is what this archive is full of.
 *
 * Note what is NOT here: the sender's country, or a locale from anywhere
 * outside the document. Guessing from an address would fail on exactly the
 * cross-border paperwork this exists for.
 */
export function inferDateConvention(text: string, language?: string | null): DateConvention {
  let dayFirst = 0;
  let monthFirst = 0;
  AMBIGUOUS_NUMERIC_DATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AMBIGUOUS_NUMERIC_DATE_RE.exec(text)) !== null) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    // Only a component that cannot be a month carries information. 03/04 says
    // nothing and must not be counted as a vote for either reading.
    if (first > 12 && second <= 12) dayFirst++;
    else if (second > 12 && first <= 12) monthFirst++;
  }
  if (dayFirst !== monthFirst) return dayFirst > monthFirst ? "dmy" : "mdy";

  return (language ?? "").trim().toLowerCase().startsWith("en") ? "mdy" : "dmy";
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

/**
 * Turn a date a model read off the page into ISO, or null.
 *
 * The vision model is asked to copy the date *as printed*, which is the right
 * instruction — reformatting is where a small model quietly invents a
 * different day — so what comes back carries the document's own convention and
 * has to be converted here rather than there.
 *
 * Five shapes, and the order is the point: every unambiguous one is tried
 * before the one that needs `convention` to be read at all.
 *
 *   24.04.2023          dotted numeric — always day-first
 *   8. September 2017   day, month name, year
 *   August 23, 2026     month name, day, year
 *   12-MAY-2013         day, month name, year, hyphenated
 *   2026-08-23          ISO, from a model that reformatted anyway
 *   03/04/2013          numeric, slash/hyphen — CONVENTION DECIDES
 *
 * Validation is the same `toIsoDate` every other route uses: an impossible
 * day, an out-of-range year or a month name that is not one all return null.
 * A model that answered with a sentence therefore contributes nothing rather
 * than a wrong date.
 */
/**
 * True when a reading names a month but no day, so its ISO form is the first of
 * that month by convention rather than because the document said so.
 *
 * `normalizeDocumentDate` cannot express this in its return value — 2012-10-01
 * is indistinguishable from a genuine first — so the caller asks separately
 * when the difference matters. It matters in exactly one place: a letterhead
 * that prints only a month must not outrank a labelled full date in the same
 * month found in the body.
 */
export function isMonthOnlyReading(value: string): boolean {
  // The same place prefix normalizeDocumentDate strips. The two have to agree
  // about what they are looking at, or a place-prefixed month resolves to an
  // assumed first while this reports a stated day — and the guard that keeps
  // assumed days from outranking stated ones stops firing exactly there.
  const text = value.trim().replace(PLACE_PREFIX_RE, "");
  return (
    /^(?:i[mn][ \t]+)?[A-Za-zÄÖÜäöü.]{3,}[ \t]+\d{4}$/i.test(text) ||
    /^\d{1,2}[/.-]\d{4}$/.test(text)
  );
}

/**
 * The place a letter names before dating itself: "München, 05.03.2022",
 * "Caorle,03/09/2016".
 *
 * A convention across most of Europe, and the model returns it because it was
 * told to copy what is printed. Stripping it here rather than teaching every
 * shape below about it keeps the five date patterns about dates.
 *
 * Deliberately narrow: letters, spaces and the punctuation that occurs inside
 * place names, and no digits at all. A prefix carrying a number is a reference,
 * an address or a line of a table, and dropping it would be a guess.
 */
const PLACE_PREFIX_RE = /^\p{L}[\p{L} .\-'’]{1,38},[ \t]*/u;

export function normalizeDocumentDate(
  value: string,
  convention: DateConvention = "dmy",
): string | null {
  const text = value.trim().replace(PLACE_PREFIX_RE, "");

  // Dotted: day-first everywhere it occurs.
  const dotted = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{2,4})$/.exec(text);
  if (dotted) return toIsoDate(dotted[1], dotted[2], dotted[3]);

  // "8. September 2017" / "12-MAY-2013" / "25 MAI 01" — day, then a spelled-out
  // month.
  //
  // The year may be two digits, which the written-month shapes refused until a
  // credit card statement from 2001 dated itself "25 MAI 01". Safe here in a
  // way it is not for a bare month and year: the day has already been consumed,
  // so a trailing number can only be the year. `toIsoDate` applies the same
  // 00-68 / 69-99 pivot the dotted form has always used.
  // The "den" is the German letterhead phrasing ("Musterstadt, den 8. September
  // 2017"), which survives the place strip and which the text scan's anchored
  // patterns already tolerate.
  const dayMonth =
    /^(?:den[ \t]+)?(\d{1,2})[.\-]?[ \t]*[-\s][ \t]*([A-Za-zÄÖÜäöü.]{3,})[-\s][ \t]*(\d{2,4})$/i.exec(
    text,
  );
  if (dayMonth) {
    const month = monthFromName(dayMonth[2]);
    if (month != null) return toIsoDate(dayMonth[1], String(month), dayMonth[3]);
  }

  // "August 23, 2026" / "März 8, 2020" — a spelled-out month, then the day.
  const monthDay = /^([A-Za-zÄÖÜäöü.]{3,})\.?[ \t]+(\d{1,2})(?:st|nd|rd|th)?,?[ \t]+(\d{2,4})$/.exec(
    text,
  );
  if (monthDay) {
    const month = monthFromName(monthDay[1]);
    if (month != null) return toIsoDate(monthDay[2], String(month), monthDay[3]);
  }

  // Already ISO — a model that reformatted despite the instruction is still
  // giving a usable answer, and refusing it would be pedantry.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return toIsoDate(iso[3], iso[2], iso[1]);

  // "Oktober 2012", "Im Oktober 2012" — a month with no day.
  //
  // The letterhead of a statement or an annual notice frequently dates itself
  // to the month alone, and the model copies that faithfully because it was
  // told to. The text scan has always resolved this shape to the first of the
  // month (BARE_MONTHYEAR_RE); without it here the same printed date produced
  // a date through one reader and null through the other, which is not a
  // defensible difference.
  //
  // The leading "im"/"in" is the German letterhead phrasing ("Im Oktober
  // 2012") and is part of what is printed, so the model returns it.
  const monthYear = /^(?:i[mn][ \t]+)?([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{4})$/i.exec(text);
  if (monthYear) {
    const month = monthFromName(monthYear[1]);
    if (month != null) return toIsoDate("1", String(month), monthYear[2]);
  }

  // "10/2012" — a numeric month and a four-digit year. Unambiguous despite the
  // slash: a four-digit second component cannot be a day, so no convention is
  // needed.
  const numericMonthYear = /^(\d{1,2})[/.-](\d{4})$/.exec(text);
  if (numericMonthYear) {
    return toIsoDate("1", numericMonthYear[1], numericMonthYear[2]);
  }

  // Numeric with a slash or hyphen: the only shape whose reading is not
  // settled by the characters themselves. Tried last so it can never take a
  // string one of the unambiguous forms above would have claimed.
  const ambiguous = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (ambiguous) {
    const [, a, b, year] = ambiguous;
    return convention === "mdy" ? toIsoDate(b, a, year) : toIsoDate(a, b, year);
  }
  return null;
}

/** A date label standing alone in a table cell ("Datum", "Rechnungsdatum"). */
const DATE_HEADER_CELL_RE = /^\W*\w*datum\W*$/i;

function isDocumentDateLabel(cell: string): boolean {
  return DATE_HEADER_CELL_RE.test(cell) && !NON_DOCUMENT_DATE_LABEL_RE.test(cell);
}

/** Numeric date anywhere inside a table cell. */
const CELL_DATE_RE = /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/;

/** ISO inside a table cell — "Lieferdatum" over "2014-11-17". */
const CELL_ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

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
  // ISO first: unambiguous, and its four-digit year cannot be mistaken by the
  // patterns below.
  const iso8601 = CELL_ISO_DATE_RE.exec(cell);
  if (iso8601) {
    const iso = toIsoDate(iso8601[3], iso8601[2], iso8601[1]);
    if (iso) return iso;
  }
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
const LINE_ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
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
  for (const re of [LINE_DATE_RE, LINE_ISO_DATE_RE, LINE_MONTHNAME_DATE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      // ISO reverses the capture order; the other two share it.
      const iso =
        re === LINE_ISO_DATE_RE
          ? toIsoDate(m[3], m[2], m[1])
          : toIsoDate(m[1], re === LINE_DATE_RE ? m[2] : String(monthFromName(m[2]) ?? 0), m[3]);
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
 * The salutation is the boundary between a German letter's letterhead and its
 * body. Everything above it — the sender block, the reference block, the date
 * line, the subject — is the document describing itself; everything below is
 * what the document is about, including any number of dates belonging to other
 * things (a validity start, a payment term, a policy anniversary).
 */
/** Patterns that may decide the date anywhere in the document (see below). */
const RANKED_PATTERN_COUNT =
  DATE_ANCHOR_PATTERNS.length +
  DATE_ANCHOR_ISO_PATTERNS.length +
  DATE_ANCHOR_MONTHDAY_PATTERNS.length +
  DATE_ANCHOR_DAYMONTH_HYPHEN_PATTERNS.length +
  DATE_ANCHOR_AMBIGUOUS_PATTERNS.length +
  DATE_ANCHOR_MONTHNAME_PATTERNS.length +
  DATE_ANCHOR_MONTHYEAR_PATTERNS.length;

/**
 * The salutation, which is what separates a letter's head from its body — and
 * therefore what the whole position rule below rests on.
 *
 * The leading class is "anything that is not a letter" rather than just
 * whitespace, because OCR routinely runs a reference number into the
 * salutation's line:
 *
 *     7933150000013509   Sehr geehrter Herr Beispiel,
 *
 * Anchored on `^[ \t]*` that is not a salutation, the letter has no
 * letterhead, and every rule that depends on one silently stops applying. It
 * stays tight where it matters: a letter before the phrase still blocks the
 * match, so this cannot fire inside prose.
 */
const SALUTATION_RE =
  /^[^\p{L}\n]*(?:sehr geehrte|sehr geehrter|guten tag|liebe[rs]?\b|hallo\b|dear\b)/imu;

/**
 * The reference block ("Ihr Schreiben vom 12.03.2024", "Ihre Nachricht vom …")
 * names the date of the letter being answered, not of this one — and it sits
 * *above* the salutation, so the position rule below would otherwise promote it
 * over the real letterhead date. Matched by looking back from the anchor, the
 * same way `isNonDocumentDateMatch` recovers its label.
 */
const REFERENCE_DATE_RE =
  /\b(?:ihr(?:e|es|em)?\s+(?:schreiben|nachricht|brief|anfrage|antrag|mail|e-?mail|fax)|ihr zeichen|bezugnehmend|in bezug auf)\b[^.\n]{0,20}$/i;

function isReferenceDateMatch(text: string, m: RegExpExecArray): boolean {
  return REFERENCE_DATE_RE.test(text.slice(Math.max(0, m.index - 60), m.index));
}

/** A bare "Oktober 2025" with no city and no "im" in front of it. */
const BARE_MONTHYEAR_RE = /\b([A-ZÄÖÜ][a-zäöü]{2,8})\.?[ \t]+(\d{4})\b/g;

/**
 * A bare "09. Oktober 2023" — the day included.
 *
 * Without this the month-year rule above matched the "Oktober 2023" inside it
 * and defaulted the day to the 1st, so a letter dated the 9th was stored as
 * the 1st. Eight days wrong is worse than empty, because it looks right.
 */
const BARE_DAY_MONTHNAME_RE =
  /\b(\d{1,2})\.?[ \t]+([A-Za-zÄÖÜäöü.]{3,})[ \t]+(\d{4})\b/g;

/**
 * A bare "24.04.2023" — no label, no city in front of it. German business
 * letters set the date alone at the top right, and the OCR text carries it as
 * a line of its own with nothing to anchor it to. Every ranked pattern needs
 * an anchor, so this shape produced no candidate at all and the field stayed
 * empty on letters that are plainly dated.
 *
 * Accepted only as a last resort, and only in the letterhead — see
 * `bareLetterheadDate`.
 */
const BARE_FULL_DATE_RE = /(?:^|[\s(])(\d{1,2})\.[ \t]*(\d{1,2})\.[ \t]*(\d{2,4})(?=$|[\s.,;)])/gm;

/**
 * Phrases introducing a date the document is *about* rather than its own: the
 * day something starts applying.
 *
 * "gilt ab" was already on the label exclusion list, but that list only guards
 * the *anchored* patterns. An unlabelled "… ab dem 1. Januar 2024" in a
 * subject line reached the letterhead rule untouched and won it on position —
 * so a letter dated October announcing a January change was filed under
 * January. Checked against the text directly before a match, the same way the
 * label exclusion recovers its label.
 */
const VALIDITY_PHRASE_RE =
  /\b(?:ab|seit|bis|zum|per|beginnend|gültig|gueltig|fällig|faellig|wirksam|geltung|wirkung|since|from|effective|due)\s*(?:dem\s+|den\s+)?$/i;

function isValidityDateMatch(text: string, m: RegExpExecArray): boolean {
  return VALIDITY_PHRASE_RE.test(text.slice(Math.max(0, m.index - 40), m.index));
}

/** Subject lines name the month the document is *about*, not its own. */
const SUBJECT_LINE_RE = /^[ \t]*(?:betreff|betr\.?|thema|ihr zeichen|unser zeichen)\b/i;

function isOnSubjectLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  return SUBJECT_LINE_RE.test(text.slice(lineStart, index));
}

/**
 * A date found in the text, with where it was found and how strong the evidence
 * was. `rank` is the position of the pattern that produced it in the list
 * below, so ordering by rank reproduces the pattern precedence exactly.
 */
interface DateCandidate {
  iso: string;
  index: number;
  rank: number;
}

function collectDateCandidates(
  text: string,
  headEnd: number,
  convention: DateConvention,
): DateCandidate[] {
  const found: DateCandidate[] = [];
  let rank = 0;

  // Iterate all matches per pattern (not just the first): a hit on a
  // non-document label like "Geburtsdatum" must be skipped in favour of a
  // later, real one rather than abandoning the pattern.
  for (const re of DATE_ANCHOR_PATTERNS) {
    const own = rank++;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isNonDocumentDateMatch(text, m) || isReferenceDateMatch(text, m)) continue;
      const iso = toIsoDate(m[1], m[2], m[3]);
      if (iso) found.push({ iso, index: m.index, rank: own });
    }
  }
  // ISO behind a label. Ranked directly after the dotted numeric form: both
  // are a label plus digits, and neither needs interpreting.
  for (const re of DATE_ANCHOR_ISO_PATTERNS) {
    const own = rank++;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isNonDocumentDateMatch(text, m) || isReferenceDateMatch(text, m)) continue;
      const iso = toIsoDate(m[3], m[2], m[1]);
      if (iso) found.push({ iso, index: m.index, rank: own });
    }
  }
  // "Date of issue August 23, 2026" — month word first, then the day.
  for (const re of DATE_ANCHOR_MONTHDAY_PATTERNS) {
    const own = rank++;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isNonDocumentDateMatch(text, m) || isReferenceDateMatch(text, m)) continue;
      const month = monthFromName(m[1]);
      if (month == null) continue;
      const iso = toIsoDate(m[2], String(month), m[3]);
      if (iso) found.push({ iso, index: m.index, rank: own });
    }
  }
  // "12-MAY-2013". Needs no label: the hyphenated spelled-out month is a shape
  // that does not occur by accident.
  for (const re of DATE_ANCHOR_DAYMONTH_HYPHEN_PATTERNS) {
    const own = rank++;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isNonDocumentDateMatch(text, m) || isReferenceDateMatch(text, m)) continue;
      const month = monthFromName(m[2]);
      if (month == null) continue;
      const iso = toIsoDate(m[1], String(month), m[3]);
      if (iso) found.push({ iso, index: m.index, rank: own });
    }
  }
  // The one convention-dependent shape, and the lowest-ranked of the anchored
  // ones for that reason.
  for (const re of DATE_ANCHOR_AMBIGUOUS_PATTERNS) {
    const own = rank++;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isNonDocumentDateMatch(text, m) || isReferenceDateMatch(text, m)) continue;
      const iso =
        convention === "mdy"
          ? toIsoDate(m[2], m[1], m[3])
          : toIsoDate(m[1], m[2], m[3]);
      if (iso) found.push({ iso, index: m.index, rank: own });
    }
  }
  // Written-month dates ("8. September 2017"). The month word is captured
  // broadly, so a non-month word (e.g. "Datum: sehr geehrte …") must be skipped
  // rather than aborting the scan.
  for (const re of DATE_ANCHOR_MONTHNAME_PATTERNS) {
    const own = rank++;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isNonDocumentDateMatch(text, m) || isReferenceDateMatch(text, m)) continue;
      const month = monthFromName(m[2]);
      if (month == null) continue;
      const iso = toIsoDate(m[1], String(month), m[3]);
      if (iso) found.push({ iso, index: m.index, rank: own });
    }
  }
  // Month-year letterhead ("Wiesloch, im Mai 2009") — day defaults to the 1st.
  for (const re of DATE_ANCHOR_MONTHYEAR_PATTERNS) {
    const own = rank++;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const month = monthFromName(m[1]);
      if (month == null) continue;
      const iso = toIsoDate("1", String(month), m[2]);
      if (iso) found.push({ iso, index: m.index, rank: own });
    }
  }
  // A bare "Oktober 2025", accepted ONLY above the salutation and not on a
  // subject line. In the letterhead a lone month and year is the document
  // dating itself; anywhere else it is prose, which is why this pattern is not
  // in the list above and cannot contribute to the fallback ordering.
  if (headEnd > 0) {
    // The day-bearing form first, and ranked above the month-only one: where
    // both match the same text ("09. Oktober 2023") the one that keeps the day
    // has to win, or the date lands on the 1st.
    const dayOwn = rank++;
    BARE_DAY_MONTHNAME_RE.lastIndex = 0;
    let d: RegExpExecArray | null;
    while ((d = BARE_DAY_MONTHNAME_RE.exec(text)) !== null) {
      if (d.index >= headEnd) break;
      if (isOnSubjectLine(text, d.index)) continue;
      if (isReferenceDateMatch(text, d)) continue;
      if (isValidityDateMatch(text, d)) continue;
      const month = monthFromName(d[2]);
      if (month == null) continue;
      const iso = toIsoDate(d[1], String(month), d[3]);
      if (iso) found.push({ iso, index: d.index, rank: dayOwn });
    }

    const own = rank++;
    BARE_MONTHYEAR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BARE_MONTHYEAR_RE.exec(text)) !== null) {
      if (m.index >= headEnd) break;
      if (isOnSubjectLine(text, m.index)) continue;
      if (isReferenceDateMatch(text, m)) continue;
      if (isValidityDateMatch(text, m)) continue;
      // A day printed in front of it means the day-bearing rule above has
      // already claimed this date with its day intact.
      if (/\d{1,2}\.?[ \t]+$/.test(text.slice(Math.max(0, m.index - 5), m.index))) continue;
      const month = monthFromName(m[1]);
      if (month == null) continue;
      const iso = toIsoDate("1", String(month), m[2]);
      if (iso) found.push({ iso, index: m.index, rank: own });
    }
  }
  return found;
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
 *
 * Two rules decide between several candidates, and the first one is the one
 * that matters:
 *
 * 1. **Above the salutation, position wins over precision.** A letter dates
 *    itself in its letterhead; every date below the salutation belongs to what
 *    the letter is *about*. A document headed "Oktober 2025" that later
 *    mentions "gültig vom 01.01.2027" is an October 2025 document, and the old
 *    ordering picked 2027 because a full date outranked a month — precision
 *    about the wrong date. The reference block is excluded from this, or the
 *    rule would promote the date of the letter being answered.
 * 2. **Below it, the strongest anchor wins**, as before: a "…datum" label beats
 *    a "vom", which beats the "Ort, TT.MM.JJJJ" convention, which beats a
 *    month without a day. Position only breaks ties. Documents with no
 *    salutation at all — invoices, statements, tables — are decided entirely
 *    this way, unchanged.
 */
export function extractDocumentDate(
  text: string,
  convention: DateConvention = "dmy",
): string | null {
  const salutationAt = SALUTATION_RE.exec(text)?.index ?? -1;
  const headEnd = salutationAt > 0 ? salutationAt : letterheadEnd(text);
  const candidates = collectDateCandidates(text, headEnd, convention);

  if (salutationAt > 0) {
    const letterhead = candidates.filter((c) => c.index < salutationAt);
    if (letterhead.length > 0) {
      letterhead.sort((a, b) => a.index - b.index || a.rank - b.rank);
      return letterhead[0].iso;
    }
  }

  const rest = candidates.filter((c) => c.rank < RANKED_PATTERN_COUNT);
  if (rest.length > 0) {
    rest.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return rest[0].iso;
  }

  const unanchored =
    extractColumnHeaderDate(text) ??
    extractAlignedColumnDate(text) ??
    bareLetterheadDate(text, headEnd);
  if (unanchored) return unanchored;

  // The bare month-year and day-month forms in the head region, for a document
  // with no salutation at all.
  //
  // A circular, a statement or a contribution notice frequently dates itself
  // "Im Januar 2020" at the top and then addresses nobody — and the whole
  // letterhead notion was tied to a salutation, so for those the block above
  // never ran and the date came out empty. Reached only after every anchored
  // pattern and both column heuristics found nothing, and the head region is
  // bounded by `letterheadEnd`, so a month named halfway down a contract
  // cannot arrive here.
  const bare = candidates.filter((c) => c.rank >= RANKED_PATTERN_COUNT);
  if (bare.length > 0) {
    bare.sort((a, b) => a.index - b.index || a.rank - b.rank);
    return bare[0].iso;
  }
  return null;
}

/**
 * How far down a document without a salutation still counts as its letterhead.
 *
 * The salutation is the better boundary and is used whenever there is one.
 * This is the fallback for the documents that address nobody — statements,
 * circulars, notices — where the alternative was to treat the whole document
 * as body text and find no date at all.
 *
 * Counted in lines rather than characters because that is what the shape
 * actually is: a sender block, some postal matter, an address, a subject.
 * OCR line lengths vary far too much for a character budget to mean the same
 * thing on two different scans.
 */
const LETTERHEAD_MAX_LINES = 25;

/**
 * Below this a document has no letterhead at all, and 0 is returned.
 *
 * "The top of the document" only means something when there is a rest for it
 * to be the top *of*. Without this a three-line fragment is entirely
 * letterhead, and "Bitte zahlen Sie bis zum 30.06.2021." dates itself from its
 * own payment deadline — which is precisely what the unanchored rules exist
 * not to do. A real letterhead is already several lines before the date: a
 * sender line, an address block, usually a contact block.
 */
const LETTERHEAD_MIN_LINES = 8;

function letterheadEnd(text: string): number {
  const offsets: number[] = [];
  let offset = 0;
  while (offsets.length <= LETTERHEAD_MAX_LINES) {
    const next = text.indexOf("\n", offset);
    if (next === -1) break;
    offset = next + 1;
    offsets.push(offset);
  }
  if (offsets.length < LETTERHEAD_MIN_LINES) return 0;
  return offsets[Math.min(offsets.length, LETTERHEAD_MAX_LINES) - 1];
}

/**
 * The unlabelled date in a letterhead, as a last resort.
 *
 * Consulted only after every anchored strategy has come up empty, so it can
 * never outrank evidence — which is the whole reason it is safe to accept a
 * date with no label at all. Three conditions keep it honest:
 *
 *   1. **Above the salutation.** Below it, an unanchored date belongs to what
 *      the letter is about — a due date, a period, a date being confirmed.
 *      Without a salutation there is no letterhead to speak of and no way to
 *      tell the two apart, so nothing is returned.
 *   2. **Not the reference block or a subject line**, the two places above the
 *      salutation that carry someone else's date. Same guards the ranked
 *      patterns use.
 *   3. **The last one wins.** The letterhead runs sender block, then postal
 *      matter, then the recipient's address, and the date sits at the end of
 *      that run, closest to the salutation. Earlier numbers up there —
 *      a franking date, a form revision like "DV 04.23" — are printing
 *      apparatus, not the letter dating itself.
 */
function bareLetterheadDate(text: string, headEnd: number): string | null {
  if (headEnd <= 0) return null;
  BARE_FULL_DATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = BARE_FULL_DATE_RE.exec(text)) !== null) {
    if (m.index >= headEnd) break;
    if (isOnSubjectLine(text, m.index)) continue;
    if (isReferenceDateMatch(text, m)) continue;
    if (isNonDocumentDateMatch(text, m)) continue;
    if (isValidityDateMatch(text, m)) continue;
    const iso = toIsoDate(m[1], m[2], m[3]);
    if (iso) last = iso;
  }
  return last;
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
const SENDER_REJECT_RE =
  /^(?:an|herr|herrn|frau|firma|betreff|betr\.?|seite|rechnung|mahnung|angebot|bescheid|mitteilung|kostenvoranschlag)\b|@|^\W*$/i;

/** How far into the document a sender may be found. Letterheads are at the top. */
const SENDER_SCAN_LINES = 40;
/** A letterhead name is a name, not a paragraph. */
const SENDER_MAX_CHARS = 80;

/**
 * Everything from a five-digit postcode onward, with any separator in front of
 * it. A postcode begins the address; it is never part of the organisation's
 * name, so this is a boundary the text states rather than one we guess at.
 *
 * The obvious alternative — cut at the first comma — is wrong. A comma is not
 * reliably a boundary in a German company name: "Muster GmbH & Co. KG,
 * Zweigniederlassung Musterstadt" and "Dr. Beispiel, Rechtsanwälte" would both
 * lose half their name to it.
 *
 * The postcode must be followed by a capitalised place name. Five digits alone
 * are not enough: "Rechnung Nr. 12345 der Beispiel GmbH" would otherwise be cut
 * down to "Rechnung Nr." — a five-digit invoice or customer number looks exactly
 * like a postcode, and only the place name after it settles which it is.
 */
const ADDRESS_TAIL_RE = /\s*(?:\s[-–]\s|[,;·|:•∙])?\s*(?:D\s*-\s*)?\b\d{5}\s+\p{Lu}.*$/u;

/**
 * A PO box tail. Letterheads print the return address with a spaced hyphen or a
 * middle dot as often as with a comma — "Beispiel Lebensversicherung AG -
 * Postfach 103969 - 69029 Musterstadt" — and cutting only at the postcode
 * leaves the box number attached to the name.
 *
 * The hyphen must be spaced on both sides. An unspaced one belongs to the name
 * ("Beispiel-Versicherung AG", "Charles-de-Gaulle-Platz").
 *
 * The separator class carries ":" and the bullet glyphs alongside the middle
 * dot because OCR rarely returns a "·" as one — a scanned return address comes
 * back as "Muster Bauspar AG : Postfach 1307" as readily as with the dot.
 * Without them the tail stays attached, and the line then matches
 * STREET_LINE_RE (name, space, digits) and is discarded as an address — the
 * sender is lost rather than merely truncated.
 */
const POBOX_TAIL_RE = /\s*(?:\s[-–]\s|[,;·|:•∙])\s*Postfach\b.*$/i;

/**
 * A street-and-number tail after a comma, for the same line without a
 * postcode ("Muster GmbH, Beispielstr. 19"). Requires the trailing number, so
 * a branch or division name after the comma is left alone.
 */
const STREET_TAIL_RE = /\s*(?:\s[-–]\s|[,;·|:•∙])\s*[^,;·|:•∙]{2,40}?\s\d{1,4}\s*[a-zA-Z]?$/;

function cleanSenderCandidate(value: string): string | null {
  // Strategy 3 takes a whole line, and a letterhead routinely prints the name
  // and the address on one of them — "Beispiel Lebensversicherungs-AG, 10850
  // Musterstadt Es betreut Sie" was stored verbatim as a sender, which then
  // became the key the learned rules and the correspondent folder are built on.
  const trimmed = value
    .replace(ADDRESS_TAIL_RE, "")
    .replace(POBOX_TAIL_RE, "")
    .replace(STREET_TAIL_RE, "");
  // Trailing separators are left behind by the cuts above ("… AG - Postfach
  // 103969 -" once the postcode goes) and are never part of a name.
  const cleaned = trimmed.replace(/\s+/g, " ").replace(/[,;·|\-–\s]+$/, "").trim();
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
  const bare: string[] = [];
  for (const line of lines) {
    if (!ORGANISATION_RE.test(line)) continue;
    const candidate = cleanSenderCandidate(line);
    if (candidate) bare.push(candidate);
  }
  if (bare.length > 0) return mostCompletePrinting(bare);

  return null;
}

/**
 * Of several letterhead lines that name an organisation, the one that prints
 * the name most completely.
 *
 * A letterhead is often set across two lines, with the legal form on the
 * second:
 *
 *     Muster Bauspar          <- no organisation word, so not a candidate
 *     Bauspar AG              <- first candidate, and only half the name
 *     Muster Bauspar AG : Postfach 1307
 *
 * Taking the first candidate stored "Bauspar AG" — which is not a company, and
 * worse, becomes the key the learned rules and the correspondent folder are
 * built on, so the same institution accumulates under two different names.
 *
 * The upgrade is deliberately narrow: a later candidate is preferred only when
 * it *contains* the first as a whole-word substring. The letterhead is then
 * printing one name at two lengths and the longer one is simply the fuller
 * printing — never a different entity. A candidate naming something else can
 * never win this way, which is what makes the rule safe without a second
 * organisation check.
 */
function mostCompletePrinting(candidates: readonly string[]): string {
  let best = candidates[0];
  const escaped = () => best.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const candidate of candidates) {
    if (candidate.length <= best.length) continue;
    if (new RegExp(`(?:^|\\W)${escaped()}(?:$|\\W)`, "iu").test(candidate)) best = candidate;
  }
  return best;
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
