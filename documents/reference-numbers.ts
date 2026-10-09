/**
 * Reference numbers (#1479): the contract, policy, customer, order and case
 * numbers a document carries, as a typed field of its own.
 *
 * `document_number` is deliberately only the document's own "#1234" sticker
 * (metadata-extract.ts), and the model's guess at a contract or insurance
 * number was dropped as noise for that field. But those numbers are exactly
 * what a household files by — and what a dossier rule (#1480) will match on.
 * So they get their own place: typed, normalised, searchable, clickable.
 *
 * Two readers feed it. The deterministic one scans the text for a label
 * ("Versicherungsnummer", "Vertragsnr.", "Kundennummer", "Aktenzeichen", …)
 * followed by a value; it is right whenever it fires and wins on conflict.
 * The model may supply what the labels miss (an unlabelled policy number in
 * a subject line) and may be wrong, so it never overrides the regex reading.
 * The classify prompt does not ask for the field yet — its character budget
 * (classify-prompt-budget.test.ts) is spent — but an answer that carries
 * `reference_numbers` is parsed and merged, so enabling it is a prompt edit.
 * A number the user typed is kept through every re-classify.
 *
 * `normalized` is the value with everything but letters and digits removed
 * and upper-cased, so "AB 12.345-6" meets "ab123456". It is what the search
 * and the list filter compare, and what the dossier rule will store.
 */

import { sql, type SQL } from "drizzle-orm";
import { documents } from "../db/schema";

export type ReferenceKind = "insurance" | "contract" | "customer" | "order" | "case" | "other";
export type ReferenceSource = "regex" | "model" | "user";

export interface DocumentReferenceNumber {
  kind: ReferenceKind;
  /** As printed, trimmed. */
  value: string;
  /** Letters and digits only, upper-cased. */
  normalized: string;
  source: ReferenceSource;
}

export const REFERENCE_KINDS: readonly ReferenceKind[] = [
  "insurance",
  "contract",
  "customer",
  "order",
  "case",
  "other",
];

/** Human labels, used by the prompt and by the UI. */
export const REFERENCE_KIND_LABELS: Record<ReferenceKind, string> = {
  insurance: "Versicherungsnummer",
  contract: "Vertragsnummer",
  customer: "Kundennummer",
  order: "Auftragsnummer",
  case: "Aktenzeichen",
  other: "Referenz",
};

/** At most this many numbers per document; beyond that the text is a table, not a letter. */
export const MAX_REFERENCE_NUMBERS = 12;

const MIN_VALUE_LENGTH = 4;
const MAX_VALUE_LENGTH = 40;

export function normalizeReference(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, "").toUpperCase();
}

/** A value worth keeping: 4–40 characters printed, at least one digit, at least 3 normalised characters. */
export function isPlausibleReferenceValue(value: string): boolean {
  const v = value.trim();
  if (v.length < MIN_VALUE_LENGTH || v.length > MAX_VALUE_LENGTH) return false;
  if (!/\p{N}/u.test(v)) return false;
  return normalizeReference(v).length >= 3;
}

/**
 * Label → kind. The alternation is matched case-insensitively against the
 * text; the value follows after an optional colon, dot or whitespace. Kept
 * in step with `REFERENCE_LABELS` in metadata-extract.ts (the tag producer),
 * which is why the same patterns appear there.
 */
const LABELS: ReadonlyArray<{ kind: ReferenceKind; label: string }> = [
  { kind: "insurance", label: String.raw`versicherungs(?:schein)?[\s-]*(?:nummer|nr\.?|konto)` },
  { kind: "insurance", label: String.raw`policen?[\s-]*(?:nummer|nr\.?)` },
  { kind: "insurance", label: String.raw`vs[\s-]*nr\.?` },
  { kind: "contract", label: String.raw`vertrags[\s-]*(?:konto(?:[\s-]*nummer)?|nummer|nr\.?)` },
  { kind: "contract", label: String.raw`darlehens[\s-]*(?:konto(?:[\s-]*nummer)?|nummer|nr\.?)` },
  { kind: "contract", label: String.raw`mitglieds[\s-]*(?:nummer|nr\.?)` },
  { kind: "customer", label: String.raw`kunden[\s-]*(?:nummer|nr\.?)` },
  { kind: "customer", label: String.raw`kd[\s.-]*nr\.?` },
  { kind: "order", label: String.raw`auftrags[\s-]*(?:nummer|nr\.?)` },
  { kind: "order", label: String.raw`bestell[\s-]*(?:nummer|nr\.?)` },
  { kind: "case", label: String.raw`aktenzeichen` },
  { kind: "case", label: String.raw`geschäftszeichen` },
  { kind: "case", label: String.raw`vorgangs[\s-]*(?:nummer|nr\.?)` },
  { kind: "case", label: String.raw`schaden[\s-]*(?:nummer|nr\.?)` },
  { kind: "case", label: String.raw`az\.?(?=[\s:])` },
  { kind: "other", label: String.raw`referenz[\s-]*(?:nummer|nr\.?)?` },
  { kind: "other", label: String.raw`ihr(?:e)?[\s-]*zeichen` },
];

// A value: starts with a letter or digit, then letters, digits and the
// separators numbers are printed with. Spaces inside are allowed only between
// digit groups ("12 345 678") so a following word is not swallowed.
// A short upper-case group ("7 K 123/24", "IV R 12/23") may sit between digit
// groups, as court and tax file numbers print it, but only when a digit follows.
const VALUE_RE = String.raw`[:\s.]*([\p{L}\p{N}][\p{L}\p{N}./-]*(?:\s(?:\p{N}[\p{L}\p{N}./-]*|\p{Lu}{1,3}(?=\s\p{N})))*)`;

/** Labelled numbers from the text, deduplicated by normalised value, in order of appearance. */
export function extractReferenceNumbers(text: string): DocumentReferenceNumber[] {
  const found: Array<{ index: number; ref: DocumentReferenceNumber }> = [];
  const seen = new Set<string>();
  for (const { kind, label } of LABELS) {
    const re = new RegExp(String.raw`(?<![\p{L}\p{N}])` + label + VALUE_RE, "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[1]!.replace(/[.\-/\s]+$/, "").trim();
      if (!isPlausibleReferenceValue(value)) continue;
      const normalized = normalizeReference(value);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      found.push({ index: m.index, ref: { kind, value, normalized, source: "regex" } });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found.slice(0, MAX_REFERENCE_NUMBERS).map((f) => f.ref);
}

function toKind(raw: unknown): ReferenceKind {
  const k = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (REFERENCE_KINDS as readonly string[]).includes(k) ? (k as ReferenceKind) : "other";
}

/**
 * The model's `reference_numbers` answer, leniently: an array of
 * `{ kind, value }`, or of bare strings. Anything implausible is dropped.
 */
export function parseModelReferenceNumbers(raw: unknown): DocumentReferenceNumber[] {
  if (!Array.isArray(raw)) return [];
  const out: DocumentReferenceNumber[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let kind: ReferenceKind = "other";
    let value = "";
    if (typeof item === "string") value = item.trim();
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      kind = toKind(o.kind);
      value = typeof o.value === "string" ? o.value.trim() : "";
    }
    if (!isPlausibleReferenceValue(value)) continue;
    const normalized = normalizeReference(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ kind, value, normalized, source: "model" });
    if (out.length >= MAX_REFERENCE_NUMBERS) break;
  }
  return out;
}

/** User-entered numbers from the edit form; every entry becomes `source: 'user'`. */
export function parseUserReferenceNumbers(
  raw: ReadonlyArray<{ kind?: string | null; value: string }>,
): DocumentReferenceNumber[] {
  const out: DocumentReferenceNumber[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const value = (item.value ?? "").trim();
    if (!isPlausibleReferenceValue(value)) continue;
    const normalized = normalizeReference(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ kind: toKind(item.kind), value, normalized, source: "user" });
    if (out.length >= MAX_REFERENCE_NUMBERS) break;
  }
  return out;
}

/**
 * One list from the three sources. Precedence per normalised value:
 * user > regex > model — a human's entry is kept as typed, the label-anchored
 * reading beats the model's guess, and the model adds only what neither has.
 */
export function mergeReferenceNumbers(
  regex: readonly DocumentReferenceNumber[] | null | undefined,
  model: readonly DocumentReferenceNumber[] | null | undefined,
  user: readonly DocumentReferenceNumber[] | null | undefined = [],
): DocumentReferenceNumber[] {
  const byNorm = new Map<string, DocumentReferenceNumber>();
  // A classification from before this field (or a test double) has no list.
  for (const list of [user ?? [], regex ?? [], model ?? []]) {
    for (const r of list) {
      if (!byNorm.has(r.normalized)) byNorm.set(r.normalized, r);
    }
  }
  return [...byNorm.values()].slice(0, MAX_REFERENCE_NUMBERS);
}

/** The entries a human typed, to carry through a re-classify. */
export function userEntered(list: readonly DocumentReferenceNumber[] | null | undefined): DocumentReferenceNumber[] {
  return (list ?? []).filter((r) => r.source === "user");
}

/** WHERE fragment: the document carries this normalised number (GIN-indexed containment). */
export function referenceNumberContains(normalized: string): SQL {
  const needle = JSON.stringify([{ normalized }]);
  return sql`${documents.reference_numbers} @> ${needle}::jsonb`;
}
