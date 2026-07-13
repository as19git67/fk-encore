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
const PERSONAL_DEDUCTION_SECTIONS_REQUIRING_USER_PAYMENT = new Set([
  "sonderausgaben",
  "vorsorgeaufwand",
  "anlage-av",
  "aussergewoehnliche",
  "haushaltsnahe",
  "anlage-kind",
  "anlage-energetisch",
]);

export interface PersonalDeductionGuardInput {
  detectedSubjectPersonIds: readonly number[];
  taxSections: readonly { slug: string }[];
}

export interface PersonalDeductionGuardResult {
  shouldReview: boolean;
  reviewSlugs: string[];
}

export const SUBJECT_PERSON_DEDUCTION_REVIEW_CONFIDENCE = 0.55;

/**
 * Return true when an AI tax assignment should be surfaced for human review
 * because it is a personal deduction on a document that deterministically
 * concerns a stored Bezugsperson. This is intentionally a soft signal: it does
 * not clear the tax assignment, because the user might genuinely pay expenses
 * for that person.
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

/**
 * Apply the subject-person deduction soft signal after all other confidence
 * mutations (especially learned-category boosts). Returns the confidence that
 * should be persisted for review routing.
 */
export function applySubjectPersonDeductionReviewConfidence(
  confidence: number,
  shouldReview: boolean,
): number {
  return shouldReview
    ? Math.min(confidence, SUBJECT_PERSON_DEDUCTION_REVIEW_CONFIDENCE)
    : confidence;
}
