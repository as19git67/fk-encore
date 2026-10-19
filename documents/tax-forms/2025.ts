/**
 * Form fields for the tax year 2025.
 *
 * Lines and Kennzahlen are copied from the official 2025 Vordrucke of the
 * Bundesfinanzverwaltung (Formular-Management-System, formulare-bfinv.de,
 * edition 2025/4.1.1.0), read on 19.10.2026: each field's Kennzahl is the
 * number printed beside its input box. `source` names the Vordruck an entry
 * was checked against; an entry without one is unchecked and the worksheet
 * prints "Kennzahl prüfen".
 *
 * Left open on purpose:
 * - Anlage V prints no Kennzahlen in 2025; its entries carry the line only,
 *   and Grundsteuer and Versicherungen none at all — they go into the
 *   umgelegte (Zeile 73) or nicht umgelegte Kosten (Zeile 76) depending on
 *   the lease, which the evidence does not say.
 * - Wahlleistungen and Beitragserstattungen of a health insurer go into
 *   different lines for statutory and private insurance; the note says which.
 * - Anlage AV has no field for the contributions: the provider transmits them.
 */

import type { FormField } from "./catalogue";

type Entry = Omit<FormField, "line" | "kennzahl" | "kennzahlSpouse" | "formNote" | "source">;
interface Place {
  line: number | null;
  kennzahl?: string | null;
  kennzahlSpouse?: string | null;
  formNote?: string | null;
  source: string;
}

const edition = (anlage: string, id: string) =>
  `${anlage} 2025, Vordruck ${id}, FMS-Ausgabe 2025/4.1.1.0 (formulare-bfinv.de), geprüft am 19.10.2026`;

const N = edition("Anlage N", "034027_25");
const VORSORGE = edition("Anlage Vorsorgeaufwand", "034098_25");
const KAP = edition("Anlage KAP", "034024_25");
const R = edition("Anlage R", "034028_25");
const AV = edition("Anlage AV", "034011_25");
const SA = edition("Anlage Sonderausgaben", "035006_25");
const HA = edition("Anlage Haushaltsnahe Aufwendungen", "035009_25");
const AGB = edition("Anlage Außergewöhnliche Belastungen", "035007_25");
const KIND = edition("Anlage Kind", "034025_25");
const V = edition("Anlage V", "034032_25");

const at = (line: number | null, kennzahl: string | null, source: string, more: Partial<Place> = {}): Place =>
  ({ line, kennzahl, source, ...more });

const ENTRIES: readonly (Entry & { place?: Place })[] = [
  // ── Anlage N ───────────────────────────────────────────────────────────
  // Lines 5–8: "Summe Lohnsteuerbescheinigung(en) der Steuerklassen 1 bis 5";
  // Steuerklasse 6 has its own column (111, 141, 151, 143).
  { key: "n.bruttoarbeitslohn", anlage: "anlage-n", label: "Bruttoarbeitslohn", kind: "amount", scope: "person", prefilled: true, place: at(5, "110", N) },
  { key: "n.lohnsteuer", anlage: "anlage-n", label: "Lohnsteuer", kind: "amount", scope: "person", prefilled: true, place: at(6, "140", N) },
  { key: "n.solidaritaetszuschlag", anlage: "anlage-n", label: "Solidaritätszuschlag", kind: "amount", scope: "person", prefilled: true, place: at(7, "150", N) },
  { key: "n.kirchensteuer", anlage: "anlage-n", label: "Kirchensteuer des Arbeitnehmers", kind: "amount", scope: "person", prefilled: true, place: at(8, "142", N) },
  { key: "werbungskosten.arbeitsmittel", anlage: "werbungskosten-n", label: "Arbeitsmittel", kind: "amount", scope: "person", prefilled: false, place: at(56, "320", N, { formNote: "Summe der Zeilen 54 und 55; die einzelnen Arbeitsmittel stehen dort." }) },
  { key: "werbungskosten.fortbildung", anlage: "werbungskosten-n", label: "Fortbildungskosten", kind: "amount", scope: "person", prefilled: false, place: at(60, "330", N) },
  { key: "werbungskosten.sonstige", anlage: "werbungskosten-n", label: "Weitere Werbungskosten", kind: "amount", scope: "person", prefilled: false, place: at(64, "380", N, { formNote: "Summe der Zeilen 61 bis 63." }) },

  // ── Anlage Vorsorgeaufwand ─────────────────────────────────────────────
  // One Vordruck for both spouses: Person A in the 300s, Person B in the 400s.
  { key: "vorsorge.rv_arbeitnehmer", anlage: "vorsorgeaufwand", label: "Arbeitnehmeranteil zur gesetzlichen Rentenversicherung", kind: "amount", scope: "person", prefilled: true, place: at(4, "300", VORSORGE, { kennzahlSpouse: "400" }) },
  { key: "vorsorge.rv_arbeitgeber", anlage: "vorsorgeaufwand", label: "Arbeitgeberanteil zur gesetzlichen Rentenversicherung", kind: "amount", scope: "person", prefilled: true, place: at(9, "304", VORSORGE, { kennzahlSpouse: "404" }) },
  { key: "vorsorge.kv_arbeitnehmer", anlage: "vorsorgeaufwand", label: "Arbeitnehmerbeiträge zur gesetzlichen Krankenversicherung", kind: "amount", scope: "person", prefilled: true, place: at(11, "320", VORSORGE, { kennzahlSpouse: "420" }) },
  { key: "vorsorge.pv_arbeitnehmer", anlage: "vorsorgeaufwand", label: "Arbeitnehmerbeiträge zur sozialen Pflegeversicherung", kind: "amount", scope: "person", prefilled: true, place: at(13, "323", VORSORGE, { kennzahlSpouse: "423" }) },
  { key: "vorsorge.av_arbeitnehmer", anlage: "vorsorgeaufwand", label: "Arbeitnehmerbeiträge zur Arbeitslosenversicherung", kind: "amount", scope: "person", prefilled: true, place: at(43, "370", VORSORGE, { kennzahlSpouse: "470" }) },
  { key: "vorsorge.kv_basis_privat", anlage: "vorsorgeaufwand", label: "Beiträge zur privaten Kranken-Basisabsicherung", kind: "amount", scope: "person", prefilled: true, place: at(23, "350", VORSORGE, { kennzahlSpouse: "450" }) },
  { key: "vorsorge.pv_privat", anlage: "vorsorgeaufwand", label: "Beiträge zur privaten Pflege-Pflichtversicherung", kind: "amount", scope: "person", prefilled: true, place: at(24, "351", VORSORGE, { kennzahlSpouse: "451" }) },
  { key: "vorsorge.kv_wahlleistungen", anlage: "vorsorgeaufwand", label: "Beiträge für Wahlleistungen und Zusatzversicherungen", kind: "amount", scope: "person", prefilled: false, place: at(null, null, VORSORGE, { formNote: "Gesetzlich versichert: Zeile 22 (Kz 338, Person B 438); privat versichert: Zeile 27 (Kz 354, Person B 454)." }) },
  { key: "vorsorge.kv_erstattungen", anlage: "vorsorgeaufwand", label: "Erstattete Beiträge zur Kranken- und Pflegeversicherung", kind: "amount", scope: "person", prefilled: true, place: at(null, null, VORSORGE, { formNote: "Erstattungen zu Arbeitnehmerbeiträgen: Zeile 14 (Kz 324, Person B 424); zu selbst gezahlten gesetzlichen Beiträgen: Zeile 19 (Kz 330, Person B 430); zu privaten Beiträgen: Zeile 25 (Person B Kz 452)." }) },
  { key: "vorsorge.basisrente", anlage: "vorsorgeaufwand", label: "Beiträge zu eigenen Basisrentenverträgen", kind: "amount", scope: "person", prefilled: true, place: at(8, "303", VORSORGE, { kennzahlSpouse: "403" }) },

  // ── Anlage KAP ─────────────────────────────────────────────────────────
  // Lines 7–15 have a second column "korrigierter Betrag" (Kz 420 ff.).
  { key: "kap.ertraege", anlage: "anlage-kap", label: "Kapitalerträge, die dem inländischen Steuerabzug unterlegen haben", kind: "amount", scope: "person", prefilled: false, place: at(7, "410", KAP) },
  { key: "kap.gewinne_aktien", anlage: "anlage-kap", label: "In den Kapitalerträgen enthaltene Gewinne aus Aktienveräußerungen", kind: "amount", scope: "person", prefilled: false, place: at(8, "412", KAP) },
  { key: "kap.verluste_aktien", anlage: "anlage-kap", label: "Nicht ausgeglichene Verluste aus der Veräußerung von Aktien", kind: "amount", scope: "person", prefilled: false, place: at(13, "416", KAP) },
  { key: "kap.verluste_sonstige", anlage: "anlage-kap", label: "Nicht ausgeglichene Verluste ohne Verluste aus Aktienveräußerungen", kind: "amount", scope: "person", prefilled: false, place: at(12, "415", KAP) },
  { key: "kap.sparer_pauschbetrag", anlage: "anlage-kap", label: "In Anspruch genommener Sparer-Pauschbetrag", kind: "amount", scope: "person", prefilled: false, place: at(16, "417", KAP) },
  { key: "kap.kapitalertragsteuer", anlage: "anlage-kap", label: "Kapitalertragsteuer", kind: "amount", scope: "person", prefilled: false, place: at(37, "480", KAP) },
  { key: "kap.solidaritaetszuschlag", anlage: "anlage-kap", label: "Solidaritätszuschlag", kind: "amount", scope: "person", prefilled: false, place: at(38, "481", KAP) },
  { key: "kap.kirchensteuer", anlage: "anlage-kap", label: "Kirchensteuer zur Kapitalertragsteuer", kind: "amount", scope: "person", prefilled: false, place: at(39, "482", KAP) },
  { key: "kap.auslaendische_steuer", anlage: "anlage-kap", label: "Anrechenbare noch nicht angerechnete ausländische Steuern", kind: "amount", scope: "person", prefilled: false, place: at(41, "484", KAP) },

  // ── Anlage R / AV ──────────────────────────────────────────────────────
  { key: "r.rente_jahresbetrag", anlage: "anlage-r", label: "Rentenbetrag (Jahresbetrag der Rente)", kind: "amount", scope: "person", prefilled: true, place: at(4, "101", R, { formNote: "Kz 101 ist die erste Rente; eine zweite Rente derselben Person steht in der Spalte daneben (Kz 151)." }) },
  { key: "av.altersvorsorgebeitraege", anlage: "anlage-av", label: "Altersvorsorgebeiträge (Riester)", kind: "amount", scope: "person", prefilled: true, place: at(null, null, AV, { formNote: "Die Anlage AV hat keine Zeile für die Beiträge: der Anbieter übermittelt sie. Einzutragen sind nur die Angaben der Zeilen 4 bis 15." }) },

  // ── Anlage Sonderausgaben ──────────────────────────────────────────────
  // Filled in jointly under joint assessment: one value per return.
  { key: "sonder.kirchensteuer_gezahlt", anlage: "sonderausgaben", label: "Gezahlte Kirchensteuer", kind: "amount", scope: "return", prefilled: false, place: at(4, "103", SA) },
  { key: "sonder.kirchensteuer_erstattet", anlage: "sonderausgaben", label: "Erstattete Kirchensteuer", kind: "amount", scope: "return", prefilled: false, place: at(4, "104", SA) },
  { key: "sonder.spenden", anlage: "sonderausgaben", label: "Zuwendungen an steuerbegünstigte Organisationen", kind: "amount", scope: "return", prefilled: false, place: at(5, "123", SA) },
  { key: "sonder.spenden_parteien", anlage: "sonderausgaben", label: "Zuwendungen an politische Parteien", kind: "amount", scope: "return", prefilled: false, place: at(7, "127", SA) },

  // ── Anlage Haushaltsnahe Aufwendungen (§ 35a EStG) ─────────────────────
  { key: "haushaltsnahe.dienstleistungen", anlage: "haushaltsnahe", label: "Haushaltsnahe Dienstleistungen (Aufwendungen)", kind: "amount", scope: "return", prefilled: false, place: at(5, "212", HA) },
  { key: "haushaltsnahe.handwerker", anlage: "haushaltsnahe", label: "Handwerkerleistungen (Arbeits-, Fahrt- und Maschinenkosten)", kind: "amount", scope: "return", prefilled: false, place: at(9, "214", HA, { formNote: "Summe der Lohnanteile; je Rechnung Rechnungsbetrag und Lohnanteil in den Zeilen 6 bis 8." }) },

  // ── Anlage Außergewöhnliche Belastungen ────────────────────────────────
  { key: "agb.krankheitskosten", anlage: "aussergewoehnliche", label: "Krankheitskosten", kind: "amount", scope: "return", prefilled: false, place: at(24, "302", AGB) },
  { key: "agb.krankheitskosten_erstattung", anlage: "aussergewoehnliche", label: "Erhaltene oder zu erwartende Erstattungen zu Krankheitskosten", kind: "amount", scope: "return", prefilled: false, place: at(25, "303", AGB) },
  { key: "agb.pflegekosten", anlage: "aussergewoehnliche", label: "Pflegekosten", kind: "amount", scope: "return", prefilled: false, place: at(27, "304", AGB) },

  // ── Anlage Kind ────────────────────────────────────────────────────────
  { key: "kind.betreuungskosten", anlage: "anlage-kind", label: "Kinderbetreuungskosten", kind: "amount", scope: "child", prefilled: false, place: at(67, "51", KIND, { formNote: "Berücksichtigungsfähige Gesamtaufwendungen der Eltern; steuerfreier Ersatz in Zeile 68 (Kz 79)." }) },
  { key: "kind.schulgeld", anlage: "anlage-kind", label: "Schulgeld", kind: "amount", scope: "child", prefilled: false, place: at(56, "24", KIND, { formNote: "Berücksichtigungsfähige Gesamtaufwendungen der Eltern." }) },

  // ── Anlage V ───────────────────────────────────────────────────────────
  // The 2025 Anlage V prints no Kennzahlen.
  { key: "v.mieteinnahmen", anlage: "anlage-v", label: "Mieteinnahmen", kind: "amount", scope: "property", prefilled: false, place: at(13, null, V, { formNote: "Mieteinnahmen für Wohnungen ohne Umlagen; andere Räume Zeile 16, an Angehörige vermietete Wohnungen Zeile 19." }) },
  { key: "v.umlagen", anlage: "anlage-v", label: "Vereinnahmte Umlagen", kind: "amount", scope: "property", prefilled: false, place: at(20, null, V, { formNote: "Laufend vereinnahmte Umlagen; Nachzahlungen und Erstattungen Zeile 21." }) },
  { key: "werbungskosten_v.schuldzinsen", anlage: "werbungskosten-v", label: "Schuldzinsen", kind: "amount", scope: "property", prefilled: false, place: at(46, null, V) },
  { key: "werbungskosten_v.erhaltung", anlage: "werbungskosten-v", label: "Erhaltungsaufwendungen", kind: "amount", scope: "property", prefilled: false, place: at(55, null, V, { formNote: "2025 voll abzuziehende Erhaltungsaufwendungen; auf bis zu 5 Jahre verteilte Zeile 57." }) },
  { key: "werbungskosten_v.grundsteuer", anlage: "werbungskosten-v", label: "Grundsteuer", kind: "amount", scope: "property", prefilled: false, place: at(null, null, V, { formNote: "Umgelegt: Zeile 73 (umgelegte Kosten); nicht umgelegt: Zeile 76." }) },
  { key: "werbungskosten_v.versicherungen", anlage: "werbungskosten-v", label: "Versicherungen", kind: "amount", scope: "property", prefilled: false, place: at(null, null, V, { formNote: "Umgelegt: Zeile 73 (umgelegte Kosten); nicht umgelegt: Zeile 76." }) },
  { key: "werbungskosten_v.verwaltung", anlage: "werbungskosten-v", label: "Verwaltungskosten", kind: "amount", scope: "property", prefilled: false, place: at(76, null, V, { formNote: "Nicht umgelegte Kosten, zusammen mit Bank- und Kontoführungsgebühren." }) },
];

export const FORM_FIELDS_2025: readonly FormField[] = ENTRIES.map(({ place, ...e }) => ({
  ...e,
  line: place?.line ?? null,
  kennzahl: place?.kennzahl ?? null,
  kennzahlSpouse: place?.kennzahlSpouse ?? null,
  formNote: place?.formNote ?? null,
  source: place?.source ?? null,
}));
