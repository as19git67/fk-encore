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
 * The document number is authoritative only from an explicit "#" marker in the
 * text. The LLM's free-form guess (often a contract/insurance/customer number)
 * is discarded. A single optional separator (space, '.', '-', ':' or '/') may
 * sit between the '#' and the digits, so "#1234", "#.1234", "# 1234" and
 * "#-1234" all yield "1234". Returns the digits without the '#', or null. (#651)
 */
export function extractDocumentNumber(text: string): string | null {
  return text.match(/#[\s.\-:/]?(\d{4,})/)?.[1] ?? null;
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
  /\b\w*datum\b[ \t:]{0,80}(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/i,
  // "Rechnung vom 18.01.2021"
  /\bvom\b[ \t:]{0,5}(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/i,
  // German letterhead convention "Ort, TT.MM.JJJJ" (4-digit year only, to keep
  // precision — a bare 2-digit year after a word is too easily a false match).
  /\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+,[ \t]{0,3}(\d{1,2})\.(\d{1,2})\.(\d{4})\b/,
];

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
 * Deterministic fallback for the document date. The small model regularly
 * returns `doc_date=null` even when the date is plainly in the text
 * ("Datum: 11.08.14", "Rechnungsdatum        18.01.2021", "Datum: 09.05.2014").
 * This scans the OCR text for a date anchored to a strong German date label
 * (a "…datum" word, "vom", or the "Ort, TT.MM.JJJJ" letterhead convention) and
 * returns it as ISO YYYY-MM-DD.
 *
 * Only *label-anchored* dates are accepted — never just any date in the text —
 * so a due date, validity date or birthdate is not mistaken for the document
 * date. Applied as a *fallback* in runClassify: it never overrides a date the
 * LLM did produce, whose nuanced choice (salary month, invoice date, …) is
 * better. Returns null when no anchored date is found. (#date-fallback)
 */
export function extractDocumentDate(text: string): string | null {
  for (const re of DATE_ANCHOR_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const iso = toIsoDate(m[1], m[2], m[3]);
    if (iso) return iso;
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
