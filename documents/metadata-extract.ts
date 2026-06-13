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
 * The document number is authoritative only from an explicit "#1234" marker in
 * the text. The LLM's free-form guess (often a contract/insurance/customer
 * number) is discarded. Returns the digits without the leading '#', or null.
 */
export function extractDocumentNumber(text: string): string | null {
  return text.match(/#(\d{4,})/)?.[1] ?? null;
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
