/**
 * Deterministic tax post-processing rules applied to the classifier output in
 * `runClassify`. Pure functions — unit-tested in tax-rules.test.ts.
 *
 * Background: a cloud-LLM audit (Claude vs. the local Qwen classifier) showed
 * the local model marks nearly EVERY private pension/life/Riester insurance
 * document as tax-relevant (→ `anlage-av` / `vorsorgeaufwand` / `anlage-r-av`),
 * even though only the actual certificate is a tax document. Claude confirmed
 * only ~24 % of the `anlage-av` assignments; the rest were mere admin mail:
 * Erhöhungsnachträge, Statusreports, Dynamik-Widersprüche, Standmitteilungen,
 * Fondsumschichtungen, Kontaktänderungen. The explicit prompt rule did not fix
 * this — the small model can't reliably make the distinction — so we enforce it
 * deterministically here, mirroring the content-rule approach in sender-rules.ts.
 */

import { normalizeForMatch } from "./sender-rules";
import type { TaxAssignment } from "./llm-client";

/**
 * Tax sections a private pension/life/Riester insurance document is (wrongly)
 * assigned. A mere admin notice — without an actual certificate — must not
 * carry these. Other sections (e.g. `aussergewoehnliche`) are never touched.
 */
const INSURANCE_TAX_SLUGS = new Set(["anlage-av", "vorsorgeaufwand", "anlage-r-av"]);

/**
 * Markers of insurance ADMIN mail (not a tax document). Given already
 * normalized (lowercase, no spaces/punctuation, umlauts kept). `dynami`
 * covers "Dynamik", "dynamische Erhöhung", "Dynamiknachtrag" and
 * "Dynamik-Widerspruch" at once.
 */
const ADMIN_MARKERS: readonly string[] = [
  "erhöhungsnachtrag",
  "dynami",
  "statusreport",
  "standmitteilung",
  "fondsumschichtung",
  "fondsersetzung",
  "fondswechsel",
  "kontaktdaten",
  "adressänderung",
  "anschriftenänderung",
  "zulagenantrag",
  "deckungskapitalübertragung",
  "kapitalübertragung",
  "konsortium",
  "beitragsanpassung",
  "erstattungsabrechnung",
  "leistungsabrechnung",
];

/**
 * Markers whose presence means the document IS a genuine tax certificate and
 * must keep its tax sections. Checked against the OCR text only (see
 * `applyInsuranceAdminTaxRule`) so an unreliable LLM-generated title claiming
 * "Beitragsbescheinigung" cannot save an actual Dynamik-Widerspruch.
 */
const BELEG_MARKERS: readonly string[] = [
  "beitragsbescheinigung",
  "zulagenbescheinigung",
  "10aestg", // "§ 10a EStG" — Riester Sonderausgabenabzug
  "92estg", // "§ 92 EStG" — Riester-Zulagenbescheinigung
  "10estg", // "§ 10 EStG" — Vorsorgeaufwand-Bescheinigung
  "rentenbezugsmitteilung",
  "steuerbescheinigung",
];

/**
 * Strip the insurance/pension tax sections from a document that is clearly
 * insurance ADMIN mail (an admin marker present) and carries NO certificate
 * marker. When that empties the tax-section list, the document is no longer
 * tax-relevant. Everything else passes through unchanged.
 *
 * Deliberately conservative: it only fires when the document already has one of
 * the insurance sections AND an admin marker AND no certificate marker — so a
 * genuine Beitrags-/Zulagenbescheinigung (certificate marker present) keeps its
 * status, and non-insurance documents are never affected.
 *
 * `text` should be the OCR-extracted document text, NOT the LLM title.
 */
export function applyInsuranceAdminTaxRule(input: {
  text: string;
  taxSections: readonly TaxAssignment[];
  taxRelevant: boolean;
}): { taxSections: TaxAssignment[]; taxRelevant: boolean } {
  const passthrough = {
    taxSections: [...input.taxSections],
    taxRelevant: input.taxRelevant,
  };

  const hasInsuranceSection = input.taxSections.some((s) => INSURANCE_TAX_SLUGS.has(s.slug));
  if (!hasInsuranceSection) return passthrough;

  const ctx = normalizeForMatch(input.text);
  if (!ctx) return passthrough;

  const hasAdmin = ADMIN_MARKERS.some((m) => ctx.includes(m));
  const hasBeleg = BELEG_MARKERS.some((m) => ctx.includes(m));
  if (!hasAdmin || hasBeleg) return passthrough;

  const kept = input.taxSections.filter((s) => !INSURANCE_TAX_SLUGS.has(s.slug));
  return {
    taxSections: kept,
    taxRelevant: kept.length > 0 ? input.taxRelevant : false,
  };
}

/**
 * A Familienkasse Kindergeld decision is not a tax assessment, but it is a
 * supporting document for Anlage Kind and the Kindergeld/Kinderfreibetrag
 * comparison. Small local models often route the statutory wording (EStG,
 * §70, "Festsetzung") to a generic tax category/section. Replace those guesses
 * with the one precise section. Only high-precision case markers fire this rule
 * so an actual Einkommensteuerbescheid that merely mentions Kindergeld remains
 * untouched.
 */
const KINDERGELD_NOTICE_MARKERS: readonly string[] = [
  "bescheidüberkindergeld",
  "kindergeldnummer",
  "festsetzungdeskindergeldes",
  "kindergeldfestsetzung",
];

export function applyKindergeldTaxRule(input: {
  text: string;
  taxSections: readonly TaxAssignment[];
  taxRelevant: boolean;
}): { taxSections: TaxAssignment[]; taxRelevant: boolean; matched: boolean } {
  const ctx = normalizeForMatch(input.text);
  if (!KINDERGELD_NOTICE_MARKERS.some((marker) => ctx.includes(marker))) {
    return {
      taxSections: [...input.taxSections],
      taxRelevant: input.taxRelevant,
      matched: false,
    };
  }
  return {
    taxSections: [{ slug: "anlage-kind", confidence: 0.98 }],
    taxRelevant: true,
    matched: true,
  };
}

/**
 * Land- und Forstwirtschaft is the one supported case where the filing year
 * follows the beginning of the shifted 1 July–30 June fiscal year.  A normal
 * EÜR with the same printed period still belongs to the calendar year in
 * which its fiscal year ends.
 *
 * Keep this deliberately narrow: both an explicit Landwirtschaft signal and
 * the complete standard fiscal-year range must be present.  This prevents a
 * generic cross-year invoice or a commercial EÜR from being moved backwards.
 */
export function applyAgricultureFiscalYearTaxRule(input: {
  text: string;
  taxSections: readonly TaxAssignment[];
  taxYear: number | null;
  taxYearConfidence: number;
}): {
  taxYear: number | null;
  taxYearConfidence: number;
  matched: boolean;
} {
  const ctx = normalizeForMatch(input.text);
  const isAgriculture =
    input.taxSections.some((section) => section.slug === "anlage-l") ||
    ctx.includes("landundforstwirtschaft") ||
    ctx.includes("landwirtschaftlicheinkünfte");
  if (!isAgriculture) {
    return {
      taxYear: input.taxYear,
      taxYearConfidence: input.taxYearConfidence,
      matched: false,
    };
  }

  const hasFiscalYearLabel =
    ctx.includes("wirtschaftsjahr") || ctx.includes("geschäftsjahr") || ctx.includes("geschaeftsjahr");
  if (!hasFiscalYearLabel) {
    return {
      taxYear: input.taxYear,
      taxYearConfidence: input.taxYearConfidence,
      matched: false,
    };
  }

  const period = /\b0?1[.\/-]0?7[.\/-](20\d{2})\s*(?:bis|[-–—])\s*30[.\/-]0?6[.\/-](20\d{2})\b/i.exec(
    input.text,
  );
  const startYear = period ? Number(period[1]) : null;
  const endYear = period ? Number(period[2]) : null;
  if (startYear == null || endYear !== startYear + 1) {
    return {
      taxYear: input.taxYear,
      taxYearConfidence: input.taxYearConfidence,
      matched: false,
    };
  }

  return {
    taxYear: startYear,
    taxYearConfidence: 0.99,
    matched: true,
  };
}

/**
 * A Kirchensteuerbescheid names the *Veranlagungsjahr* in its heading
 * ("Kirchensteuerbescheid 2019"), but the Kirchensteuer is a Sonderausgabe in
 * the year the money actually moves (§ 11 EStG, Zu-/Abflussprinzip): a
 * Nachzahlung is deductible, an Erstattung reduces the deduction — both in the
 * year of the payment/refund, which is the year the Bescheid settles, not the
 * assessed year. Example: "Kirchensteuerbescheid 2019" issued 19.04.2021 with a
 * remaining Guthaben belongs to tax year 2021.
 *
 * Both the LLM and the file name usually take the heading year, so fix it here.
 *
 * Deliberately narrow: the document must be an actual Kirchensteuer assessment
 * AND show a settlement (Guthaben/Erstattung/Nachzahlung/verbleibende Steuer).
 * A pure Vorauszahlungsbescheid — whose instalments fall due in several later
 * years — is left untouched.
 */
const KIRCHENSTEUER_NOTICE_MARKERS: readonly string[] = [
  "kirchensteuerbescheid",
  "kirchensteueramt",
  "kirchensteuerfestsetzung",
];

const KIRCHENSTEUER_SETTLEMENT_MARKERS: readonly string[] = [
  "verbleibendekirchensteuer",
  "verbleibendesteuer",
  "verbleibendesguthaben",
  "guthaben",
  "erstattung",
  "nachzahlung",
  "abrechnungderveranlagung",
];

/** A Vorauszahlungsbescheid without any settlement must keep its own year. */
const KIRCHENSTEUER_PREPAYMENT_ONLY_MARKERS: readonly string[] = [
  "vorauszahlungsbescheid",
  "festsetzungdervorauszahlungen",
];

/**
 * Date the Bescheid is settled: an explicit due date wins over the date the
 * Bescheid was issued, because a notice issued in late December can be payable
 * in January. Run against the raw text (not `normalizeForMatch`, which strips
 * the date separators).
 */
function settlementYearFromText(text: string): number | null {
  const patterns: readonly RegExp[] = [
    /f[äa]llig(?:keit)?(?:\s*(?:ist|wird|am|zum|bis))?[^0-9]{0,20}(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})/i,
    /(?:zahlbar|zu\s+zahlen)\s+(?:bis|am|zum)\s*(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})/i,
    /bescheid(?:es|s)?\s*v(?:om|\.)\s*(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return Number(match[3]);
  }
  return null;
}

export function applyKirchensteuerBescheidYearTaxRule(input: {
  text: string;
  /** LLM-extracted document date, "YYYY-MM-DD" — the Bescheiddatum fallback. */
  docDate: string | null;
  taxYear: number | null;
  taxYearConfidence: number;
}): { taxYear: number | null; taxYearConfidence: number; matched: boolean } {
  const unchanged = {
    taxYear: input.taxYear,
    taxYearConfidence: input.taxYearConfidence,
    matched: false,
  };

  const ctx = normalizeForMatch(input.text);
  if (!KIRCHENSTEUER_NOTICE_MARKERS.some((m) => ctx.includes(m))) return unchanged;
  if (!KIRCHENSTEUER_SETTLEMENT_MARKERS.some((m) => ctx.includes(m))) return unchanged;
  if (
    KIRCHENSTEUER_PREPAYMENT_ONLY_MARKERS.some((m) => ctx.includes(m)) &&
    !ctx.includes("kirchensteuerbescheid")
  ) {
    return unchanged;
  }

  const docDateYear = /^(\d{4})-/.exec(input.docDate ?? "")?.[1];
  const settlementYear = settlementYearFromText(input.text) ?? (docDateYear ? Number(docDateYear) : null);
  if (settlementYear == null) return unchanged;

  // Only ever move the year forward: the payment/refund cannot happen before
  // the assessed year, and a smaller value means the extracted date is wrong.
  if (input.taxYear != null && settlementYear < input.taxYear) return unchanged;
  if (settlementYear === input.taxYear) {
    return { taxYear: settlementYear, taxYearConfidence: input.taxYearConfidence, matched: true };
  }

  return { taxYear: settlementYear, taxYearConfidence: 0.95, matched: true };
}

/**
 * Bank-/Broker-Abrechnungen über Kapitalerträge (Dividendengutschrift,
 * "Steuerliche Behandlung: Ausländische Dividende", Wertpapierabrechnung,
 * Erträgnisaufstellung, Jahressteuerbescheinigung) gehören ausschließlich in
 * die KAP-Sektionen.
 *
 * Problem: solche Belege weisen Kapitalertragsteuer, Solidaritätszuschlag UND
 * Kirchensteuer aus, und die comdirect-Fußnote erklärt zusätzlich, dass die
 * Kirchensteuer „als Sonderausgabe" den KESt-Satz senkt. Das kleine Modell
 * liest daraus Abzugs-Sektionen heraus und hängt `sonderausgaben` und
 * `vorsorgeaufwand` an das Dokument — obwohl die Kirchensteuer hier bereits im
 * Steuerabzug verrechnet ist und der Beleg mit Vorsorgeaufwendungen nichts zu
 * tun hat. Der Prompt (Abgrenzungsregel 1) reicht dafür nicht aus, also wird es
 * hier deterministisch erzwungen.
 */

/** Belegart: was für ein Bank-/Broker-Dokument ist das? */
const SECURITIES_SETTLEMENT_MARKERS: readonly string[] = [
  "steuerlichebehandlung",
  "dividendengutschrift",
  "dividendenabrechnung",
  "ausländischedividende",
  "inländischedividende",
  "wertpapierabrechnung",
  "erträgnisabrechnung",
  "erträgnisaufstellung",
  "ertragsgutschrift",
  "ausschüttung",
  "vorabpauschale",
  "zinsgutschrift",
  "jahressteuerbescheinigung",
];

/** Wertpapier-Kontext: belegt, dass es wirklich um ein Depot geht. */
const SECURITIES_CONTEXT_MARKERS: readonly string[] = [
  "isin",
  "wkn",
  "depotnummer",
  "depotkonto",
  "kapitalertragsteuer",
];

/**
 * Kontexte, in denen dieselben Wörter etwas anderes bedeuten: eine
 * fondsgebundene Renten-/Lebensversicherung nennt ISIN und Ausschüttung,
 * gehört aber zu `vorsorgeaufwand`/`anlage-av`; ein Einkommensteuerbescheid
 * des Finanzamts listet Kapitalerträge, ist aber ein `steuerbescheid`.
 */
const SECURITIES_EXCLUSION_MARKERS: readonly string[] = [
  "rentenversicherung",
  "lebensversicherung",
  "riester",
  "rürup",
  "basisrente",
  "versicherungsschein",
  "versicherungsnummer",
  "policennummer",
  "pensionskasse",
  "direktversicherung",
  "krankenversicherung",
  "beitragsbescheinigung",
  "finanzamt",
  "einkommensteuerbescheid",
];

/** Sektionen, die ein Kapitalertragsbeleg behalten darf. */
const KAP_TAX_SLUGS = new Set(["anlage-kap", "werbungskosten-kap"]);

export function applySecuritiesSettlementTaxRule(input: {
  text: string;
  taxSections: readonly TaxAssignment[];
  taxRelevant: boolean;
}): { taxSections: TaxAssignment[]; taxRelevant: boolean; matched: boolean } {
  const unchanged = {
    taxSections: [...input.taxSections],
    taxRelevant: input.taxRelevant,
    matched: false,
  };

  const ctx = normalizeForMatch(input.text);
  if (!ctx) return unchanged;
  if (!SECURITIES_SETTLEMENT_MARKERS.some((m) => ctx.includes(m))) return unchanged;
  if (!SECURITIES_CONTEXT_MARKERS.some((m) => ctx.includes(m))) return unchanged;
  if (SECURITIES_EXCLUSION_MARKERS.some((m) => ctx.includes(m))) return unchanged;

  const kept = input.taxSections.filter((s) => KAP_TAX_SLUGS.has(s.slug));
  if (!kept.some((s) => s.slug === "anlage-kap")) {
    kept.unshift({ slug: "anlage-kap", confidence: 0.95 });
  }

  const changed =
    kept.length !== input.taxSections.length || input.taxRelevant !== true;
  return { taxSections: kept, taxRelevant: true, matched: changed };
}

/** Exposed for tests / diagnostics. */
export const INSURANCE_ADMIN_TAX_RULE_INTERNALS = {
  INSURANCE_TAX_SLUGS,
  ADMIN_MARKERS,
  BELEG_MARKERS,
};

export const KINDERGELD_TAX_RULE_INTERNALS = {
  KINDERGELD_NOTICE_MARKERS,
};

export const KIRCHENSTEUER_TAX_RULE_INTERNALS = {
  KIRCHENSTEUER_NOTICE_MARKERS,
  KIRCHENSTEUER_SETTLEMENT_MARKERS,
  KIRCHENSTEUER_PREPAYMENT_ONLY_MARKERS,
};

export const SECURITIES_SETTLEMENT_TAX_RULE_INTERNALS = {
  SECURITIES_SETTLEMENT_MARKERS,
  SECURITIES_CONTEXT_MARKERS,
  SECURITIES_EXCLUSION_MARKERS,
  KAP_TAX_SLUGS,
};
