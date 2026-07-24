/**
 * Canonical set of document *types* (Dokumentarten) — a facet orthogonal to
 * the category (Lebensbereich) taxonomy.
 *
 * Rationale: the category answers "which area of life does this belong to?"
 * (finanzen, wohnen, gesundheit …); the document type answers "what KIND of
 * paperwork is it?" (Rechnung, Bescheid, Vertrag …). Baking the type into the
 * category caused type-specific data to bleed across a sender's documents
 * (e.g. a "wertpapierkauf" tag on a dividend statement). A separate facet keeps
 * the categories pure and lets the UI filter "all Policen" across life-areas.
 *
 * The vocabulary was sized against the real 7000-document corpus (see
 * scripts/taxonomy/document_type_survey.sql): a keyword survey put >92 % of
 * documents into one of these buckets, the rest being a genuine long-tail that
 * lands on `sonstiges`.
 *
 * Used in three places, mirroring `tax-sections.ts`:
 *   1. `documents/document-ops.ts` — sent as the fixed label set to the
 *      classifier (`llm-service` renders it into the /classify prompt).
 *   2. `documents/llm-client.ts` — validates the returned slug.
 *   3. Frontend — filter chip + document detail.
 *
 * A document has exactly ONE type (unlike tax sections, which are N:M): the
 * value lives directly on `documents.document_type`.
 */

export interface DocumentType {
  slug: string;
  name: string;
  /** Short German hint sent to the classifier (and shown to the user) telling
   *  what kind of paperwork belongs here, with priority carve-outs for the
   *  common ambiguities the corpus survey surfaced. */
  hint: string;
}

// Declared in rough priority order (most specific / most distinctive first) so
// a human skimming the list reads the discriminating types before the generic
// fallbacks. The classifier is additionally given explicit priority rules in
// classify-prompts.ts.
export const DOCUMENT_TYPES: readonly DocumentType[] = [
  {
    slug: "gutschrift",
    name: "Gutschrift / Erstattung",
    hint: "Geldeingang zugunsten des Empfängers: Dividenden-/Ertragsgutschrift, Ausschüttung, Beitragsrückerstattung, Steuererstattung. Vorrang vor abrechnung/rechnung, wenn es um eine Gutschrift geht.",
  },
  {
    slug: "rechnung",
    name: "Rechnung / Mahnung",
    hint: "Zahlungsaufforderung an den Empfänger: Rechnung, Beitragsrechnung, Mahnung, Zahlungserinnerung. NICHT periodische Aufstellung (→ abrechnung), NICHT Gutschrift (→ gutschrift).",
  },
  {
    slug: "abrechnung",
    name: "Abrechnung / Kontoauszug",
    hint: "Periodische Aufstellung: Jahres-/Nebenkosten-/Gehalts-/Entgeltabrechnung, Kontoauszug, Erträgnisaufstellung, Wertpapierabrechnung (Kauf/Verkauf).",
  },
  {
    slug: "bescheid",
    name: "Bescheid / Festsetzung",
    hint: "Hoheitliche Entscheidung von Behörde, Gericht oder Versicherer: Bescheid, Festsetzung, Feststellung, Beschluss, Bewilligung, Genehmigung.",
  },
  {
    slug: "bescheinigung",
    name: "Bescheinigung / Nachweis",
    hint: "Bestätigender Nachweis: Bescheinigung, Nachweis, Zertifikat, Bestätigung, Attest, Meldung, Garantie/Gewährleistung.",
  },
  {
    slug: "standmitteilung",
    name: "Standmitteilung / Report",
    hint: "Periodischer Vertrags-/Depotstand ohne Handlungsbedarf: Standmitteilung, Statusreport, Wertentwicklung, Depot-/Vermögensreporting. NICHT allgemeines Anschreiben (→ mitteilung).",
  },
  {
    slug: "mitteilung",
    name: "Mitteilung / Anschreiben",
    hint: "Informierendes Schreiben: Mitteilung, Information, Anschreiben, Benachrichtigung, Hinweis, Einladung.",
  },
  {
    slug: "erklaerung",
    name: "Erklärung",
    hint: "Vom Bürger/Empfänger abgegebene Erklärung: Steuererklärung, Teilungserklärung, Organspende-Erklärung, Einverständniserklärung. NICHT auszufüllendes Antragsformular (→ antrag).",
  },
  {
    slug: "antrag",
    name: "Antrag / Formular",
    hint: "Antrag oder auszufüllendes Formular: Antrag, Formular, Fragebogen, Anmeldung, Auftrag (z. B. Freistellungsauftrag), Bestellung.",
  },
  {
    slug: "vollmacht",
    name: "Vollmacht",
    hint: "Bevollmächtigung: Vollmacht, Vorsorge-/Konto-/Generalvollmacht.",
  },
  {
    slug: "urkunde",
    name: "Urkunde / Zeugnis",
    hint: "Amtliche oder feierliche Urkunde: Personenstandsurkunde, Zeugnis, Diplom, Ehrenzeichen/Ehrung.",
  },
  {
    slug: "ausweis",
    name: "Ausweis",
    hint: "Identitäts-/Legitimationsdokument: Personalausweis, Betreuerausweis, Mitgliedsausweis, Schwerbehindertenausweis, Pass.",
  },
  {
    slug: "bericht",
    name: "Bericht / Befund",
    hint: "Fachlicher Bericht: Arztbrief, Befund, Laborwerte, Gutachten, Protokoll, Rechenschaftsbericht.",
  },
  {
    slug: "rezept",
    name: "Rezept / Verordnung",
    hint: "Ärztliche Verordnung: Rezept, Verordnung (z. B. Brillenverordnung), Heil- und Kostenplan.",
  },
  {
    slug: "angebot",
    name: "Angebot / Kostenvoranschlag",
    hint: "Vorvertragliches Angebot: Angebot, Kostenvoranschlag, Kalkulation.",
  },
  {
    slug: "beleg",
    name: "Beleg / Quittung",
    hint: "Kaufnachweis: Kassenbon, Quittung, Kaufbeleg, Lieferschein.",
  },
  {
    slug: "vertrag",
    name: "Vertrag / Police",
    hint: "Vertragsdokument: Vertrag, Police/Versicherungsschein, Vereinbarung, Vertragsnachtrag, SEPA-Mandat, Bedingungen/AVB, Abonnement. NICHT die Beitragsrechnung zum Vertrag (→ rechnung).",
  },
  {
    slug: "korrespondenz",
    name: "Korrespondenz / Schreiben",
    hint: "Allgemeiner Schriftverkehr ohne spezifischeren Typ: Brief, Schreiben, Widerspruch, Widerruf/Belehrung, Kündigung.",
  },
  {
    slug: "anleitung",
    name: "Anleitung / Merkblatt",
    hint: "Erläuterndes Dokument: Bedienungsanleitung, Handbuch, Merkblatt, Satzung, Glossar.",
  },
  {
    slug: "sonstiges",
    name: "Sonstiges",
    hint: "LETZTE WAHL — nur, wenn keine andere Dokumentart passt.",
  },
] as const;

export type DocumentTypeSlug = typeof DOCUMENT_TYPES[number]["slug"];

const SLUGS: ReadonlySet<string> = new Set(DOCUMENT_TYPES.map((t) => t.slug));

export function isValidDocumentTypeSlug(slug: unknown): slug is DocumentTypeSlug {
  return typeof slug === "string" && SLUGS.has(slug);
}

export function findDocumentType(slug: string): DocumentType | undefined {
  return DOCUMENT_TYPES.find((t) => t.slug === slug);
}

/** Human label for a slug, or the slug itself when unknown (so the frontend
 *  can render whatever the DB contains without crashing). */
export function documentTypeName(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return findDocumentType(slug)?.name ?? slug;
}
