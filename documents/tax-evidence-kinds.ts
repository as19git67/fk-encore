/**
 * Kinds of tax evidence and the values printed on each
 * (documentation/plans/steuer-ausfuellhilfe.md, stage 1).
 *
 * The reading step (stage 2) first asks the model which kind a document
 * is — among the kinds that fit its sections and document type — and then
 * asks for exactly that kind's fields. Each field names the form field it
 * feeds; the mapping in `tax-form-mapping.ts` sums and applies the law.
 *
 * A field's `label` is the wording on the document, so the model can find
 * it; `hint` says where it stands when the wording varies between issuers.
 * Plausibility rules reject values that cannot both be right.
 */

import type { DocumentTypeSlug } from "./document-types";
import type { TaxSectionSlug } from "./tax-sections";

export interface EvidenceField {
  /** Unique within the kind: "bruttoarbeitslohn". */
  key: string;
  /** As printed on the document. */
  label: string;
  hint?: string;
  kind: "amount" | "flag";
  /** The form field (catalogue key) the value feeds; null for values that only steer a rule. */
  formKey: string | null;
}

export interface EvidenceKind {
  key: string;
  name: string;
  /** Sections this kind is evidence for. */
  sections: readonly TaxSectionSlug[];
  /** Document types it comes as (the classifier's Dokumentart). */
  documentTypes: readonly DocumentTypeSlug[];
  /** For the model: how to recognise it. */
  recognise: string;
  fields: readonly EvidenceField[];
  /** Pairs of values that cannot both be right; each returns a reason or null. */
  checks?: readonly ((v: Readonly<Record<string, number>>) => string | null)[];
}

/** A over B, in cents, with a cent of rounding either way. */
const atMost = (a: number | undefined, b: number | undefined, factor: number, what: string): string | null =>
  a !== undefined && b !== undefined && a > Math.round(b * factor) + 100 ? what : null;

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  {
    key: "lohnsteuerbescheinigung",
    name: "Lohnsteuerbescheinigung",
    sections: ["anlage-n", "vorsorgeaufwand"],
    documentTypes: ["bescheinigung"],
    recognise: "Ausdruck der elektronischen Lohnsteuerbescheinigung des Arbeitgebers, nummerierte Zeilen 1 bis 33.",
    fields: [
      { key: "bruttoarbeitslohn", label: "Bruttoarbeitslohn", hint: "Zeile 3", kind: "amount", formKey: "n.bruttoarbeitslohn" },
      { key: "lohnsteuer", label: "Einbehaltene Lohnsteuer", hint: "Zeile 4", kind: "amount", formKey: "n.lohnsteuer" },
      { key: "solidaritaetszuschlag", label: "Einbehaltener Solidaritätszuschlag", hint: "Zeile 5", kind: "amount", formKey: "n.solidaritaetszuschlag" },
      { key: "kirchensteuer", label: "Einbehaltene Kirchensteuer des Arbeitnehmers", hint: "Zeile 6", kind: "amount", formKey: "n.kirchensteuer" },
      { key: "rv_arbeitgeber", label: "Arbeitgeberanteil zur gesetzlichen Rentenversicherung", hint: "Zeile 22a", kind: "amount", formKey: "vorsorge.rv_arbeitgeber" },
      { key: "rv_arbeitnehmer", label: "Arbeitnehmeranteil zur gesetzlichen Rentenversicherung", hint: "Zeile 23a", kind: "amount", formKey: "vorsorge.rv_arbeitnehmer" },
      { key: "kv_arbeitnehmer", label: "Arbeitnehmerbeiträge zur gesetzlichen Krankenversicherung", hint: "Zeile 25", kind: "amount", formKey: "vorsorge.kv_arbeitnehmer" },
      { key: "pv_arbeitnehmer", label: "Arbeitnehmerbeiträge zur sozialen Pflegeversicherung", hint: "Zeile 26", kind: "amount", formKey: "vorsorge.pv_arbeitnehmer" },
      { key: "av_arbeitnehmer", label: "Arbeitnehmerbeiträge zur Arbeitslosenversicherung", hint: "Zeile 27", kind: "amount", formKey: "vorsorge.av_arbeitnehmer" },
    ],
    checks: [
      (v) => atMost(v.lohnsteuer, v.bruttoarbeitslohn, 0.5, "Lohnsteuer über der Hälfte des Bruttoarbeitslohns"),
      (v) => atMost(v.solidaritaetszuschlag, v.lohnsteuer, 0.055, "Solidaritätszuschlag über 5,5 % der Lohnsteuer"),
      (v) => atMost(v.kirchensteuer, v.lohnsteuer, 0.09, "Kirchensteuer über 9 % der Lohnsteuer"),
      (v) => atMost(v.rv_arbeitnehmer, v.bruttoarbeitslohn, 0.2, "Rentenversicherung über 20 % des Bruttoarbeitslohns"),
    ],
  },
  {
    key: "jahressteuerbescheinigung",
    name: "Jahressteuerbescheinigung der Bank",
    sections: ["anlage-kap"],
    documentTypes: ["bescheinigung"],
    recognise: "Steuerbescheinigung eines Kreditinstituts über Kapitalerträge des Jahres (nach amtlichem Muster), oft mit Verlustbescheinigung. Nicht die Erträgnisaufstellung.",
    fields: [
      { key: "ertraege", label: "Höhe der Kapitalerträge", kind: "amount", formKey: "kap.ertraege" },
      { key: "gewinne_aktien", label: "Gewinn aus Kapitalerträgen im Sinne des § 20 Abs. 2 Satz 1 Nr. 1 EStG (Aktienveräußerung)", kind: "amount", formKey: "kap.gewinne_aktien" },
      { key: "verluste_aktien", label: "Verlust aus der Veräußerung von Aktien, nicht ausgeglichen", hint: "Verlustbescheinigung", kind: "amount", formKey: "kap.verluste_aktien" },
      { key: "verluste_sonstige", label: "Verlust ohne Verlust aus der Veräußerung von Aktien, nicht ausgeglichen", hint: "Verlustbescheinigung", kind: "amount", formKey: "kap.verluste_sonstige" },
      { key: "sparer_pauschbetrag", label: "In Anspruch genommener Sparer-Pauschbetrag", kind: "amount", formKey: "kap.sparer_pauschbetrag" },
      { key: "kapitalertragsteuer", label: "Kapitalertragsteuer", kind: "amount", formKey: "kap.kapitalertragsteuer" },
      { key: "solidaritaetszuschlag", label: "Solidaritätszuschlag", kind: "amount", formKey: "kap.solidaritaetszuschlag" },
      { key: "kirchensteuer", label: "Kirchensteuer zur Kapitalertragsteuer", kind: "amount", formKey: "kap.kirchensteuer" },
      { key: "auslaendische_steuer", label: "Summe der anrechenbaren noch nicht angerechneten ausländischen Steuer", kind: "amount", formKey: "kap.auslaendische_steuer" },
    ],
    checks: [
      (v) => atMost(v.kapitalertragsteuer, v.ertraege, 0.25, "Kapitalertragsteuer über 25 % der Kapitalerträge"),
      (v) => atMost(v.solidaritaetszuschlag, v.kapitalertragsteuer, 0.055, "Solidaritätszuschlag über 5,5 % der Kapitalertragsteuer"),
      (v) => atMost(v.sparer_pauschbetrag, 200000, 1, "Sparer-Pauschbetrag über 2.000 €"),
    ],
  },
  {
    key: "beitragsbescheinigung_kv",
    name: "Beitragsbescheinigung Kranken- und Pflegeversicherung",
    sections: ["vorsorgeaufwand"],
    documentTypes: ["bescheinigung"],
    recognise: "Jahresbescheinigung einer Kranken- oder Pflegeversicherung über gezahlte Beiträge für die Steuererklärung.",
    fields: [
      { key: "kv_basis", label: "Beiträge zur Basis-Krankenversicherung", kind: "amount", formKey: "vorsorge.kv_basis_privat" },
      { key: "pv", label: "Beiträge zur Pflege-Pflichtversicherung", kind: "amount", formKey: "vorsorge.pv_privat" },
      { key: "wahlleistungen", label: "Beiträge für Wahlleistungen / Zusatzversicherungen", kind: "amount", formKey: "vorsorge.kv_wahlleistungen" },
      { key: "erstattungen", label: "Beitragserstattungen", kind: "amount", formKey: "vorsorge.kv_erstattungen" },
    ],
  },
  {
    key: "basisrente_bescheinigung",
    name: "Bescheinigung Basisrente (Rürup)",
    sections: ["vorsorgeaufwand"],
    documentTypes: ["bescheinigung"],
    recognise: "Bescheinigung nach § 10 Abs. 2a EStG über Beiträge zu einem Basisrentenvertrag.",
    fields: [{ key: "beitraege", label: "Beiträge zum Basisrentenvertrag", kind: "amount", formKey: "vorsorge.basisrente" }],
  },
  {
    key: "riester_bescheinigung",
    name: "Bescheinigung Altersvorsorgebeiträge (Riester)",
    sections: ["anlage-av"],
    documentTypes: ["bescheinigung"],
    recognise: "Bescheinigung nach § 92 EStG über Altersvorsorgebeiträge.",
    fields: [{ key: "beitraege", label: "Altersvorsorgebeiträge", kind: "amount", formKey: "av.altersvorsorgebeitraege" }],
  },
  {
    key: "rentenbezugsmitteilung",
    name: "Renteninformation / Rentenbezugsmitteilung",
    sections: ["anlage-r"],
    documentTypes: ["bescheinigung", "mitteilung", "bescheid"],
    recognise: "Mitteilung des Rententrägers über die im Jahr gezahlte Rente (Jahresbetrag).",
    fields: [{ key: "jahresbetrag", label: "Rentenbetrag des Jahres", kind: "amount", formKey: "r.rente_jahresbetrag" }],
  },
  {
    key: "handwerkerrechnung",
    name: "Handwerkerrechnung",
    sections: ["haushaltsnahe"],
    documentTypes: ["rechnung", "beleg"],
    recognise: "Rechnung eines Handwerksbetriebs für Arbeiten im Haushalt (Reparatur, Wartung, Modernisierung, Schornsteinfeger).",
    fields: [
      { key: "arbeitskosten", label: "Arbeits-, Fahrt- und Maschinenkosten (Lohnanteil)", hint: "oft „davon Lohnkosten“ oder getrennt ausgewiesen", kind: "amount", formKey: "haushaltsnahe.handwerker" },
      { key: "material", label: "Materialkosten", kind: "amount", formKey: null },
      { key: "rechnungsbetrag", label: "Rechnungsbetrag brutto", kind: "amount", formKey: null },
      { key: "bargeld", label: "Barzahlung", hint: "1 bei Barzahlung, 0 bei Überweisung oder Lastschrift", kind: "flag", formKey: null },
    ],
    checks: [(v) => atMost(v.arbeitskosten, v.rechnungsbetrag, 1, "Arbeitskosten über dem Rechnungsbetrag")],
  },
  {
    key: "dienstleistungsrechnung",
    name: "Rechnung haushaltsnahe Dienstleistung",
    sections: ["haushaltsnahe"],
    documentTypes: ["rechnung", "beleg"],
    recognise: "Rechnung für eine Dienstleistung im Haushalt: Gartenpflege, Reinigung, Winterdienst, Pflege- oder Betreuungsleistung.",
    fields: [
      { key: "arbeitskosten", label: "Kosten der Dienstleistung ohne Material", kind: "amount", formKey: "haushaltsnahe.dienstleistungen" },
      { key: "rechnungsbetrag", label: "Rechnungsbetrag brutto", kind: "amount", formKey: null },
      { key: "bargeld", label: "Barzahlung", hint: "1 bei Barzahlung, 0 bei Überweisung oder Lastschrift", kind: "flag", formKey: null },
    ],
    checks: [(v) => atMost(v.arbeitskosten, v.rechnungsbetrag, 1, "Dienstleistungskosten über dem Rechnungsbetrag")],
  },
  {
    key: "nebenkostenabrechnung",
    name: "Nebenkostenabrechnung mit § 35a-Ausweis",
    sections: ["haushaltsnahe"],
    documentTypes: ["abrechnung"],
    recognise: "Betriebs- oder Nebenkostenabrechnung, Hausgeldabrechnung, mit ausgewiesenen Anteilen nach § 35a EStG.",
    fields: [
      { key: "dienstleistungen", label: "Anteil haushaltsnahe Dienstleistungen nach § 35a Abs. 2 EStG", kind: "amount", formKey: "haushaltsnahe.dienstleistungen" },
      { key: "handwerker", label: "Anteil Handwerkerleistungen nach § 35a Abs. 3 EStG", kind: "amount", formKey: "haushaltsnahe.handwerker" },
    ],
  },
  {
    key: "zuwendungsbestaetigung",
    name: "Zuwendungsbestätigung (Spendenquittung)",
    sections: ["sonderausgaben"],
    documentTypes: ["bescheinigung", "beleg"],
    recognise: "Bestätigung über Zuwendungen nach amtlichem Muster (Geld- oder Sachspende, Mitgliedsbeitrag) oder Sammelbestätigung.",
    fields: [
      { key: "betrag", label: "Betrag der Zuwendung", kind: "amount", formKey: "sonder.spenden" },
      { key: "partei", label: "Empfänger ist eine politische Partei", hint: "1 bei Partei, sonst 0", kind: "flag", formKey: null },
    ],
  },
  {
    key: "kirchensteuerbescheid",
    name: "Kirchensteuerbescheid",
    sections: ["sonderausgaben"],
    documentTypes: ["bescheid"],
    recognise: "Bescheid über Kirchensteuer oder Kirchgeld mit Nachzahlung oder Erstattung.",
    fields: [
      { key: "nachzahlung", label: "Nachzahlung", kind: "amount", formKey: "sonder.kirchensteuer_gezahlt" },
      { key: "erstattung", label: "Erstattung", kind: "amount", formKey: "sonder.kirchensteuer_erstattet" },
    ],
  },
  {
    key: "krankheitskosten",
    name: "Rechnung Krankheitskosten",
    sections: ["aussergewoehnliche"],
    documentTypes: ["rechnung", "beleg", "rezept"],
    recognise: "Arzt-, Zahnarzt-, Apotheken- oder Heilmittelrechnung, die selbst getragen wurde.",
    fields: [{ key: "betrag", label: "Rechnungsbetrag", kind: "amount", formKey: "agb.krankheitskosten" }],
  },
  {
    key: "krankheitskosten_erstattung",
    name: "Erstattung Krankheitskosten",
    sections: ["aussergewoehnliche"],
    documentTypes: ["abrechnung", "bescheid", "mitteilung"],
    recognise: "Leistungsabrechnung oder Erstattungsmitteilung einer Kranken- oder Beihilfekasse zu eingereichten Rechnungen.",
    fields: [{ key: "erstattung", label: "Erstatteter Betrag", kind: "amount", formKey: "agb.krankheitskosten_erstattung" }],
  },
  {
    key: "kinderbetreuung",
    name: "Rechnung Kinderbetreuung",
    sections: ["anlage-kind"],
    documentTypes: ["rechnung", "bescheinigung", "bescheid", "abrechnung"],
    recognise: "Rechnung oder Jahresbescheinigung von Kita, Hort, Tagesmutter oder Betreuungseinrichtung.",
    fields: [
      { key: "betreuung", label: "Betreuungskosten ohne Verpflegung", kind: "amount", formKey: "kind.betreuungskosten" },
      { key: "verpflegung", label: "Verpflegungskosten", hint: "zählen nicht, nur getrennt erkennen", kind: "amount", formKey: null },
    ],
  },
  {
    key: "schulgeld",
    name: "Schulgeldbescheinigung",
    sections: ["anlage-kind"],
    documentTypes: ["rechnung", "bescheinigung"],
    recognise: "Bescheinigung oder Rechnung einer Privatschule über Schulgeld.",
    fields: [{ key: "schulgeld", label: "Schulgeld ohne Beherbergung, Betreuung und Verpflegung", kind: "amount", formKey: "kind.schulgeld" }],
  },
];

/** The kinds a document may be, given its sections and its document type. */
export function evidenceKindsFor(sections: readonly string[], documentType: string | null): EvidenceKind[] {
  return EVIDENCE_KINDS.filter((k) =>
    k.sections.some((s) => sections.includes(s))
    && (documentType === null || (k.documentTypes as readonly string[]).includes(documentType)));
}

export function findEvidenceKind(key: string): EvidenceKind | undefined {
  return EVIDENCE_KINDS.find((k) => k.key === key);
}

/** The reasons a kind's values cannot all be right; empty when they can. */
export function checkEvidenceValues(kind: EvidenceKind, values: Readonly<Record<string, number>>): string[] {
  return (kind.checks ?? []).map((check) => check(values)).filter((reason): reason is string => reason !== null);
}
