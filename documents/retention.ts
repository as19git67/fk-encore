/**
 * Derived retention guidance (Aufbewahrungsfrist) — Stufe C.
 *
 * The retention of a household document is almost always a *function* of its
 * category (Lebensbereich) and its document type (Dokumentart), so we DERIVE it
 * instead of storing a per-document column. This module is the single source of
 * that mapping and is pure (no DB), so the rules are unit-tested in isolation.
 *
 * IMPORTANT — this is orientation, NOT legal/tax advice. Private individuals in
 * Germany generally have no statutory retention obligation; the classes below
 * reflect common practical recommendations (keep certificates forever, keep
 * tax-relevant papers ~10 years, keep contracts until they end, toss the rest
 * when no longer needed). The UI must present it as a non-binding hint.
 */

export type RetentionClass =
  | "dauerhaft" // keep permanently (certificates, wills, pension notices …)
  | "steuer_10" // ~10 years, tax-relevant papers
  | "bis_ende" // until an event ends (contract term, warranty period)
  | "kurz" // short-lived — discard once no longer needed
  | "unbekannt"; // no rule matched

export interface RetentionInfo {
  cls: RetentionClass;
  /** Short German label for the class. */
  label: string;
  /** Minimum years to keep from the reference date; null when not year-based. */
  years: number | null;
  /** One-line German rationale, framed as guidance. */
  note: string;
}

// ─── Rule inputs ─────────────────────────────────────────────────────────────

/** Categories whose documents are lifelong records regardless of type. */
const PERMANENT_CATEGORIES: ReadonlySet<string> = new Set([
  "familie-urkunden",
  "familie-ausweise",
  "bildung-zeugnisse",
  "bildung-zertifikate",
  "vereine-urkunden",
  "rechtliches-vollmachten",
  "rechtliches-verfuegungen",
  "rechtliches-nachlass",
  "altersvorsorge-gesetzlich",
  "altersvorsorge-betrieblich",
  "betreuung-bestellung",
  "wohnen-haus-kaufvertrag",
  "kapitalanlage-immobilie-kaufvertrag",
  "gesundheit-schwerbehinderung",
]);

/** Document types that are lifelong records regardless of category. */
const PERMANENT_TYPES: ReadonlySet<string> = new Set(["urkunde", "ausweis", "vollmacht"]);

/** Categories that are inherently tax-relevant (keep ~10 years). */
const TAX_CATEGORIES: ReadonlySet<string> = new Set([
  "finanzen-steuern",
  "finanzen-kirchensteuer",
  "behoerden-steuerbescheid",
  "kapitalanlage-immobilie-anlage-v",
  "landwirtschaft-steuer",
]);

/** Document types with no lasting value once the matter is settled. */
const SHORT_TYPES: ReadonlySet<string> = new Set([
  "standmitteilung",
  "mitteilung",
  "anleitung",
  "korrespondenz",
  "rechnung",
  "abrechnung",
  "beleg",
  "gutschrift",
  "angebot",
]);

const TAX_YEARS = 10;

// ─── Derivation ──────────────────────────────────────────────────────────────

/**
 * Derive the retention guidance for a document from its category, document type
 * and tax relevance. Pure; evaluated as first-match-wins in priority order.
 */
export function retentionFor(input: {
  categorySlug: string | null | undefined;
  documentType: string | null | undefined;
  taxRelevant: boolean;
}): RetentionInfo {
  const cat = input.categorySlug ?? null;
  const type = input.documentType ?? null;

  // 1) Lifelong records — by category or by document type.
  if ((cat && PERMANENT_CATEGORIES.has(cat)) || (type && PERMANENT_TYPES.has(type))) {
    return {
      cls: "dauerhaft",
      label: "Dauerhaft aufbewahren",
      years: null,
      note: "Urkunden, Nachweise und Vorsorgedokumente sollten dauerhaft aufbewahrt werden.",
    };
  }

  // 2) Tax-relevant papers — the deduction/assessment window.
  if (input.taxRelevant || (cat && TAX_CATEGORIES.has(cat))) {
    return {
      cls: "steuer_10",
      label: "Ca. 10 Jahre (steuerlich)",
      years: TAX_YEARS,
      note: "Steuerlich relevante Unterlagen: als Orientierung rund 10 Jahre aufbewahren.",
    };
  }

  // 3) Contracts and warranty-bearing purchases — keep until the matter ends.
  if (type === "vertrag" || cat === "landwirtschaft-pacht") {
    return {
      cls: "bis_ende",
      label: "Bis Vertragsende",
      years: null,
      note: "Vertragsunterlagen bis zum Ende des Vertrags (plus Puffer) aufbewahren.",
    };
  }
  if (cat === "anschaffungen") {
    return {
      cls: "bis_ende",
      label: "Bis Garantie-/Gewährleistungsende",
      years: null,
      note: "Kaufbeleg und Garantie bis zum Ablauf von Gewährleistung/Garantie aufbewahren.",
    };
  }

  // 4) Short-lived paperwork.
  if (type && SHORT_TYPES.has(type)) {
    return {
      cls: "kurz",
      label: "Kurzfristig / nach Bedarf",
      years: null,
      note: "Kann entsorgt werden, sobald der Vorgang erledigt und nicht steuerrelevant ist.",
    };
  }

  return {
    cls: "unbekannt",
    label: "Keine Einschätzung",
    years: null,
    note: "Keine Aufbewahrungs-Empfehlung ableitbar.",
  };
}

/**
 * The earliest year the document may be discarded, for year-based classes
 * (`steuer_10`). Returns null when the class is not year-based or no reference
 * year is available. The reference year is the tax year (if any) or the year of
 * the document date.
 */
export function retainUntilYear(
  info: RetentionInfo,
  refs: { taxYear: number | null | undefined; docDate: string | null | undefined },
): number | null {
  if (info.years == null) return null;
  const ref =
    (Number.isInteger(refs.taxYear) ? (refs.taxYear as number) : null) ??
    yearFromIsoDate(refs.docDate);
  if (ref == null) return null;
  return ref + info.years;
}

function yearFromIsoDate(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = /^(\d{4})-/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}
