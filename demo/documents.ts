/**
 * The documents of the demo household (documentation/plans/demodaten.md,
 * stage 2): which letters, bills, statements and receipts it holds, decided
 * by the code from the household plan and the seed. No database and no
 * rendering here — the plan is a list, so a test can check it without
 * either, and the same seed and day give the same documents.
 *
 * A document that belongs to a booking (the phone bill to the direct
 * debit, the payslip to the salary) carries the booking's amount and date;
 * a document without one (a contract, a notice, the statement) is dated by
 * the calendar. The texts here are templates; `doc-text-llm.ts` may replace
 * the wording, never the facts (sender, date, amounts, references).
 *
 * What the classification is expected to find (category, document type,
 * tax role) is the `truth` of each document, measured after the pipeline
 * ran (`truth.ts`).
 */

import { createRandom, type Random } from "./random";
import { DEMO_BANK, DEMO_COUNTERPARTIES as CP, DEMO_HOUSEHOLD } from "./names";
import type { DemoSize, HouseholdPlan, PlannedAccount, PlannedBooking } from "./household";

export type DocKind =
  | "payslip"
  | "wage_tax_certificate"
  | "phone_bill"
  | "bank_statement"
  | "bank_tax_certificate"
  | "utility_bill"
  | "advance_plan"
  | "rental_contract"
  | "service_charges"
  | "child_benefit_notice"
  | "insurance_premium"
  | "craftsman_invoice"
  | "doctor_bill"
  | "car_repair_invoice"
  | "donation_receipt"
  | "tax_assessment"
  | "online_invoice"
  | "receipt"
  | "pension_info"
  | "car_insurance"
  | "school_letter"
  | "club_letter"
  | "health_insurer_letter"
  | "price_change"
  | "bank_letter"
  | "insurer_letter"
  | "securities_buy"
  | "securities_sell"
  | "distribution"
  | "depot_statement";

export type TaxRole = "beleg" | "bezug" | "keine";

/** What the classification should find; `null` where the generator has no firm opinion. */
export interface DocTruth {
  category: string;
  documentType: string;
  taxRole: TaxRole | null;
}

/** Facts of each kind the pipeline is measured against. */
export const DOC_TRUTH: Record<DocKind, DocTruth> = {
  payslip: { category: "finanzen-gehalt", documentType: "abrechnung", taxRole: "keine" },
  wage_tax_certificate: { category: "finanzen-gehalt", documentType: "bescheinigung", taxRole: "beleg" },
  phone_bill: { category: "vertraege-telekom", documentType: "rechnung", taxRole: "keine" },
  bank_statement: { category: "finanzen-kontoauszuege", documentType: "standmitteilung", taxRole: "keine" },
  bank_tax_certificate: { category: "finanzen-steuern", documentType: "bescheinigung", taxRole: "beleg" },
  utility_bill: { category: "vertraege-strom", documentType: "abrechnung", taxRole: null },
  advance_plan: { category: "vertraege-strom", documentType: "mitteilung", taxRole: "keine" },
  rental_contract: { category: "wohnen-miete", documentType: "vertrag", taxRole: "keine" },
  service_charges: { category: "wohnen-nebenkosten", documentType: "abrechnung", taxRole: null },
  child_benefit_notice: { category: "familie-familienleistungen", documentType: "bescheid", taxRole: null },
  insurance_premium: { category: "versicherungen-sach", documentType: "rechnung", taxRole: null },
  craftsman_invoice: { category: "wohnen", documentType: "rechnung", taxRole: "beleg" },
  doctor_bill: { category: "gesundheit-arzt", documentType: "rechnung", taxRole: null },
  car_repair_invoice: { category: "fahrzeug-werkstatt", documentType: "rechnung", taxRole: "keine" },
  donation_receipt: { category: "finanzen-spenden", documentType: "bescheinigung", taxRole: "beleg" },
  tax_assessment: { category: "finanzen-steuern", documentType: "bescheid", taxRole: "bezug" },
  online_invoice: { category: "anschaffungen", documentType: "rechnung", taxRole: "keine" },
  receipt: { category: "anschaffungen", documentType: "beleg", taxRole: "keine" },
  pension_info: { category: "altersvorsorge-gesetzlich", documentType: "mitteilung", taxRole: "keine" },
  car_insurance: { category: "fahrzeug-versicherung", documentType: "rechnung", taxRole: null },
  school_letter: { category: "familie-schule", documentType: "korrespondenz", taxRole: "keine" },
  club_letter: { category: "vereine-mitgliedschaft", documentType: "korrespondenz", taxRole: "keine" },
  health_insurer_letter: { category: "versicherungen-kranken", documentType: "mitteilung", taxRole: "keine" },
  price_change: { category: "vertraege-strom", documentType: "mitteilung", taxRole: "keine" },
  bank_letter: { category: "finanzen-bankvertraege", documentType: "mitteilung", taxRole: "keine" },
  insurer_letter: { category: "versicherungen-sach", documentType: "mitteilung", taxRole: "keine" },
  securities_buy: { category: "finanzen-wertpapiere", documentType: "abrechnung", taxRole: "keine" },
  securities_sell: { category: "finanzen-wertpapiere", documentType: "abrechnung", taxRole: null },
  distribution: { category: "finanzen-wertpapiere", documentType: "gutschrift", taxRole: null },
  depot_statement: { category: "finanzen-wertpapiere", documentType: "standmitteilung", taxRole: "keine" },
};

export type Recipient = "self" | "spouse" | "both";

export interface DocLine {
  text: string;
  /** Signed, in cents; `null` for a line without an amount (a heading). */
  cents: number | null;
}

/** One row of a bank statement. */
export interface StatementRow {
  date: string;
  text: string;
  cents: number;
}

/** One position of a depot statement. */
export interface DepotPosition {
  name: string;
  isin: string;
  quantity: number;
  price: number;
  /** In cents. */
  valueCents: number;
}

export interface PlannedDocument {
  /** Stable within a plan: `<kind>-<n>`. */
  key: string;
  kind: DocKind;
  /** YYYY-MM-DD, the date printed on the document. */
  date: string;
  sender: string;
  senderAddress: string;
  recipient: Recipient;
  subject: string;
  /** Printed in the info block: customer number, invoice number … */
  references: Array<{ label: string; value: string }>;
  /** Template wording; the model may rewrite it. */
  paragraphs: string[];
  lines: DocLine[];
  /** The amount the document is about (invoice total, net pay, refund), in cents. */
  totalCents: number | null;
  statement: { opening: number; closing: number; rows: StatementRow[]; account: string; iban: string } | null;
  /** Label and value lines of a settlement ("Kurswert 2.960,00 EUR"). */
  facts: Array<{ label: string; value: string }>;
  /** The holdings table of a depot statement. */
  positions: DepotPosition[] | null;
  /** Index into `plan.bookings` of the booking this document belongs to. */
  booking: number | null;
  /** One of the letter layouts, so the documents do not all look alike. */
  layout: 0 | 1 | 2;
  /** Rendered as an image-only scan (no text layer), about one in ten. */
  scan: boolean;
  truth: DocTruth;
}

export interface DocumentPlan {
  documents: PlannedDocument[];
}

const TARGET: Record<DemoSize, number> = { full: 500, small: 30 };

const MONTHS_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/** "1.234,56 €" */
export function euro(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${euros},${String(abs % 100).padStart(2, "0")} €`;
}

/** "26.10.2026" */
export function germanDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthLabel(iso: string): string {
  return `${MONTHS_DE[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/** A made-up street address for an organisation, stable per name. */
function addressOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const streets = ["Musterallee", "Beispielweg", "Demostraße", "Am Musterplatz", "Beispielring"];
  return `${streets[h % streets.length]} ${1 + (h % 90)}, 12345 Musterstadt`;
}

/** Splits `total` into `n` positive parts (cents) that add up exactly. */
function split(rnd: Random, total: number, n: number): number[] {
  if (n <= 1) return [total];
  const weights = Array.from({ length: n }, () => 1 + rnd.next() * 3);
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  parts[n - 1] += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}

function recipientName(r: Recipient): string {
  if (r === "self") return DEMO_HOUSEHOLD.self;
  if (r === "spouse") return DEMO_HOUSEHOLD.spouse;
  return `${DEMO_HOUSEHOLD.self} und ${DEMO_HOUSEHOLD.spouse}`;
}

export function recipientBlock(r: Recipient): string[] {
  const [street, city] = DEMO_HOUSEHOLD.address.split(", ");
  return [r === "both" ? "Familie Mustermann" : recipientName(r), street, city];
}

interface Builder {
  rnd: Random;
  plan: HouseholdPlan;
  out: PlannedDocument[];
  counter: Map<DocKind, number>;
}

/**
 * A document before the plan gives it its key, layout and scan. Another
 * planner (the depot) hands drafts in; `bookingRef` is its booking, found
 * by identity in the merged booking list.
 */
export type DocumentDraft = Omit<PlannedDocument, "key" | "layout" | "scan" | "truth" | "senderAddress" | "statement" | "facts" | "positions"> & {
  statement?: PlannedDocument["statement"];
  senderAddress?: string;
  facts?: PlannedDocument["facts"];
  positions?: PlannedDocument["positions"];
  bookingRef?: PlannedBooking;
};

function push(b: Builder, d: DocumentDraft): void {
  const n = (b.counter.get(d.kind) ?? 0) + 1;
  b.counter.set(d.kind, n);
  const { bookingRef, ...rest } = d;
  const bookingIndex = bookingRef ? b.plan.bookings.indexOf(bookingRef) : -1;
  b.out.push({
    ...rest,
    key: `${d.kind}-${n}`,
    senderAddress: d.senderAddress ?? addressOf(d.sender),
    statement: d.statement ?? null,
    facts: d.facts ?? [],
    positions: d.positions ?? null,
    booking: bookingIndex >= 0 ? bookingIndex : d.booking,
    layout: b.rnd.int(0, 2) as 0 | 1 | 2,
    // Statements run over several pages and receipts are slips: both stay digital.
    scan: d.kind !== "bank_statement" && d.kind !== "receipt" && b.rnd.chance(0.1),
    truth: DOC_TRUTH[d.kind],
  });
}

function fromBooking(b: Builder, index: number, booking: PlannedBooking): void {
  const { rnd } = b;
  const amount = Math.abs(booking.cents);
  const ref = (prefix: string) => `${prefix}-${booking.date.slice(0, 4)}-${rnd.int(10_000, 99_999)}`;
  switch (booking.kind) {
    case "salary": {
      const self = booking.account === "giro_self";
      const gross = Math.round(amount / 0.64);
      const tax = Math.round(gross * 0.14);
      const health = Math.round(gross * 0.085);
      const pension = Math.round(gross * 0.093);
      const care = Math.round(gross * 0.02);
      const unemployment = gross - amount - tax - health - pension - care;
      push(b, {
        kind: "payslip",
        date: addDays(booking.date, -3),
        sender: self ? CP.employerSelf : CP.employerSpouse,
        recipient: self ? "self" : "spouse",
        subject: `Entgeltabrechnung ${monthLabel(booking.date)}`,
        references: [{ label: "Personalnummer", value: self ? "000101" : "000202" }, { label: "Abrechnungsmonat", value: monthLabel(booking.date) }],
        paragraphs: [`Ihre Entgeltabrechnung für ${monthLabel(booking.date)}. Der Auszahlungsbetrag wird auf Ihr Konto überwiesen.`],
        lines: [
          { text: "Grundgehalt", cents: gross },
          { text: "Lohnsteuer", cents: -tax },
          { text: "Krankenversicherung AN-Anteil", cents: -health },
          { text: "Rentenversicherung AN-Anteil", cents: -pension },
          { text: "Pflegeversicherung AN-Anteil", cents: -care },
          { text: "Arbeitslosenversicherung AN-Anteil", cents: -unemployment },
        ],
        totalCents: amount,
        booking: index,
      });
      return;
    }
    case "phone":
      push(b, {
        kind: "phone_bill",
        date: addDays(booking.date, -10),
        sender: CP.phone,
        recipient: "self",
        subject: `Ihre Mobilfunkrechnung ${monthLabel(booking.date)}`,
        references: [{ label: "Kundennummer", value: "K-000555" }, { label: "Rechnungsnummer", value: ref("MF") }],
        paragraphs: ["vielen Dank für Ihre Nutzung unseres Netzes. Der Rechnungsbetrag wird zum Fälligkeitstag von Ihrem Konto abgebucht."],
        lines: [
          { text: "Grundgebühr Tarif Demo M", cents: Math.round(amount / 1.19) },
          { text: "Umsatzsteuer 19 %", cents: amount - Math.round(amount / 1.19) },
        ],
        totalCents: amount,
        booking: index,
      });
      return;
    case "utility_settlement": {
      const year = Number(booking.date.slice(0, 4)) - 1;
      const refund = booking.cents > 0;
      const [power, gas] = split(rnd, rnd.int(1_800, 3_200) * 100, 2);
      const paid = power + gas + (refund ? amount : -amount);
      push(b, {
        kind: "utility_bill",
        date: addDays(booking.date, -14),
        sender: CP.utilities,
        recipient: "both",
        subject: `Jahresabrechnung Strom und Gas ${year}`,
        references: [{ label: "Vertragskonto", value: "000123" }, { label: "Abrechnungszeitraum", value: `01.01.${year} – 31.12.${year}` }],
        paragraphs: [refund
          ? `mit dieser Abrechnung erhalten Sie ein Guthaben von ${euro(amount)}, das wir Ihrem Konto gutschreiben.`
          : `aus dieser Abrechnung ergibt sich eine Nachzahlung von ${euro(amount)}, die wir von Ihrem Konto abbuchen.`],
        lines: [
          { text: `Strom ${rnd.int(2_400, 3_600)} kWh`, cents: power },
          { text: `Gas ${rnd.int(9_000, 14_000)} kWh`, cents: gas },
          { text: "Geleistete Abschläge", cents: -paid },
        ],
        totalCents: booking.cents > 0 ? -amount : amount,
        booking: index,
      });
      return;
    }
    case "insurance":
      push(b, {
        kind: "insurance_premium",
        date: addDays(booking.date, -20),
        sender: CP.insurer,
        recipient: "self",
        subject: `Beitragsrechnung ${booking.date.slice(0, 4)}`,
        references: [{ label: "Versicherungsschein", value: "VS-000777" }],
        paragraphs: ["wir danken für Ihr Vertrauen. Den Jahresbeitrag für Ihre Hausrat- und Privathaftpflichtversicherung buchen wir zum Fälligkeitstag ab."],
        lines: split(rnd, amount, 2).map((c, i) => ({ text: i === 0 ? "Hausratversicherung" : "Privathaftpflichtversicherung", cents: c })),
        totalCents: amount,
        booking: index,
      });
      return;
    case "craftsman": {
      const labour = Math.round(amount * 0.6);
      push(b, {
        kind: "craftsman_invoice",
        date: addDays(booking.date, -12),
        sender: CP.craftsman,
        recipient: "both",
        subject: "Rechnung Malerarbeiten in Ihrer Wohnung",
        references: [{ label: "Rechnungsnummer", value: booking.purpose.split(" ")[1] ?? ref("RE") }, { label: "Leistungsort", value: DEMO_HOUSEHOLD.address }],
        paragraphs: ["für die ausgeführten Arbeiten erlauben wir uns zu berechnen. Die Arbeitskosten sind gesondert ausgewiesen (§ 35a EStG)."],
        lines: [
          { text: "Arbeitskosten Malerarbeiten Wohnzimmer und Flur", cents: labour },
          { text: "Material (Farbe, Abdeckung)", cents: amount - labour },
        ],
        totalCents: amount,
        booking: index,
      });
      return;
    }
    case "doctor":
      push(b, {
        kind: "doctor_bill",
        date: addDays(booking.date, -16),
        sender: CP.doctor,
        recipient: "spouse",
        subject: "Privatärztliche Liquidation",
        references: [{ label: "Rechnungsnummer", value: booking.purpose.split(" ")[1] ?? ref("PR") }],
        paragraphs: ["für die ärztliche Behandlung erlaube ich mir nach der Gebührenordnung für Ärzte zu berechnen."],
        lines: split(rnd, amount, rnd.int(2, 4)).map((c, i) => ({ text: ["Beratung", "Untersuchung", "Bericht", "Laborleistung"][i], cents: c })),
        totalCents: amount,
        booking: index,
      });
      return;
    case "car_repair":
      push(b, {
        kind: "car_repair_invoice",
        date: addDays(booking.date, -2),
        sender: CP.garage,
        recipient: "self",
        subject: "Werkstattrechnung",
        references: [{ label: "Auftrag", value: booking.purpose.split(" ")[1] ?? ref("WA") }, { label: "Kennzeichen", value: "ZZ-D 000" }],
        paragraphs: ["vielen Dank für Ihren Auftrag. Wir berechnen die folgenden Arbeiten an Ihrem Fahrzeug."],
        lines: split(rnd, amount, 3).map((c, i) => ({ text: ["Inspektion nach Herstellervorgabe", "Bremsbeläge vorne erneuert", "Ersatzteile und Kleinmaterial"][i], cents: c })),
        totalCents: amount,
        booking: index,
      });
      return;
    case "donation":
      push(b, {
        kind: "donation_receipt",
        date: addDays(booking.date, 30),
        sender: CP.charity,
        recipient: "self",
        subject: "Bestätigung über Geldzuwendungen",
        references: [{ label: "Zuwendung vom", value: germanDate(booking.date) }],
        paragraphs: [
          `Bestätigung über Geldzuwendungen im Sinne des § 10b EStG an eine der in § 5 Abs. 1 Nr. 9 KStG bezeichneten Körperschaften. Betrag der Zuwendung: ${euro(amount)}.`,
          "Es handelt sich nicht um den Verzicht auf Erstattung von Aufwendungen. Wir sind wegen Förderung mildtätiger Zwecke vom Finanzamt Musterstadt von der Körperschaftsteuer befreit.",
        ],
        lines: [],
        totalCents: amount,
        booking: index,
      });
      return;
    case "tax_refund": {
      const year = Number(booking.date.slice(0, 4)) - 1;
      push(b, {
        kind: "tax_assessment",
        date: addDays(booking.date, -5),
        sender: CP.taxOffice,
        recipient: "both",
        subject: `Bescheid für ${year} über Einkommensteuer und Solidaritätszuschlag`,
        references: [{ label: "Steuernummer", value: "000/000/00000" }],
        paragraphs: [
          `Festsetzung für ${year}. Zusammenveranlagung. Die Erstattung von ${euro(amount)} wird auf das angegebene Konto überwiesen.`,
          "Dieser Bescheid ist nach § 165 Abs. 1 Satz 2 AO teilweise vorläufig. Gegen diesen Bescheid kann innerhalb eines Monats nach Bekanntgabe Einspruch eingelegt werden.",
        ],
        lines: [
          { text: "Festgesetzte Einkommensteuer", cents: rnd.int(8_000, 14_000) * 100 },
          { text: "Erstattung", cents: amount },
        ],
        totalCents: amount,
        booking: index,
      });
      return;
    }
    case "online": {
      const n = rnd.int(1, 3);
      push(b, {
        kind: "online_invoice",
        date: addDays(booking.date, -1),
        sender: CP.online,
        recipient: booking.account === "giro_self" ? "self" : "spouse",
        subject: `Rechnung zu Ihrer Bestellung ${booking.purpose.split(" ")[1] ?? ""}`.trim(),
        references: [{ label: "Bestellnummer", value: booking.purpose.split(" ")[1] ?? ref("BV") }],
        paragraphs: ["vielen Dank für Ihre Bestellung. Der Betrag wird per Lastschrift eingezogen."],
        lines: split(rnd, amount, n).map((c, i) => ({ text: ["Küchenwaage", "Buch", "Spielzeug", "Gartenschere", "Wasserkocher"][(i + rnd.int(0, 4)) % 5], cents: c })),
        totalCents: amount,
        booking: index,
      });
      return;
    }
    case "groceries":
    case "pharmacy":
    case "fuel": {
            const items = booking.kind === "fuel"
        ? ["Super E10"]
        : booking.kind === "pharmacy"
          ? ["Nasenspray", "Pflaster", "Halstabletten"]
          : ["Brot", "Milch", "Äpfel", "Käse", "Nudeln", "Kaffee", "Joghurt", "Tomaten"];
      const n = Math.min(items.length, rnd.int(1, 5));
      push(b, {
        kind: "receipt",
        date: booking.date,
        sender: booking.counterparty,
        recipient: "both",
        subject: "Kassenbon",
        references: [{ label: "Bon-Nr.", value: String(rnd.int(1_000, 9_999)) }],
        paragraphs: ["Vielen Dank für Ihren Einkauf!"],
        lines: split(rnd, amount, n).map((c, i) => ({ text: items[i], cents: c })),
        totalCents: amount,
        booking: index,
      });
      return;
    }
    default:
      return;
  }
}

/** Documents that belong to a year, not to a booking. */
function yearly(b: Builder, year: number, from: string, to: string): void {
  const { rnd, plan } = b;
  const inRange = (d: string) => d >= from && d <= to;

  // Wage tax certificates for last year, from that year's payslips.
  for (const who of ["self", "spouse"] as const) {
    const date = `${year}-02-20`;
    if (!inRange(date)) continue;
    const slips = b.out.filter((d) => d.kind === "payslip" && d.recipient === who && d.date.startsWith(String(year - 1)));
    if (!slips.length) continue;
    const gross = slips.reduce((s, d) => s + (d.lines[0].cents ?? 0), 0);
    const tax = slips.reduce((s, d) => s - (d.lines[1].cents ?? 0), 0);
    push(b, {
      kind: "wage_tax_certificate",
      date,
      sender: who === "self" ? CP.employerSelf : CP.employerSpouse,
      recipient: who,
      subject: `Ausdruck der elektronischen Lohnsteuerbescheinigung für ${year - 1}`,
      references: [{ label: "eTIN", value: who === "self" ? "MSTRMNMX00A00" : "MSTRMNRK00A00" }, { label: "Bescheinigungszeitraum", value: `01.01.–31.12.${year - 1}` }],
      paragraphs: ["Die Daten wurden an die Finanzverwaltung übermittelt."],
      lines: [
        { text: "3. Bruttoarbeitslohn", cents: gross },
        { text: "4. Einbehaltene Lohnsteuer", cents: tax },
      ],
      totalCents: gross,
      booking: null,
    });
  }

  const at = (month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  if (inRange(at(1, 25))) {
    const interest = plan.bookings.filter((x) => x.kind === "interest" && x.date.startsWith(String(year - 1))).reduce((s, x) => s + x.cents, 0);
    if (interest > 0) {
      push(b, {
        kind: "bank_tax_certificate",
        date: at(1, 25),
        sender: DEMO_BANK.name,
        recipient: "self",
        subject: `Jahressteuerbescheinigung ${year - 1}`,
        references: [{ label: "Kundennummer", value: "0000100004" }],
        paragraphs: ["Bescheinigung für alle Privatkonten und/oder -depots. Kapitalerträge wurden im Rahmen des Freistellungsauftrags vom Steuerabzug freigestellt."],
        lines: [
          { text: "Höhe der Kapitalerträge", cents: interest },
          { text: "Davon freigestellt", cents: interest },
          { text: "Kapitalertragsteuer", cents: 0 },
        ],
        totalCents: interest,
        booking: null,
      });
    }
  }

  if (inRange(at(4, 2))) {
    push(b, {
      kind: "advance_plan",
      date: at(4, 2),
      sender: CP.utilities,
      recipient: "both",
      subject: `Ihr Abschlagsplan ${year}`,
      references: [{ label: "Vertragskonto", value: "000123" }],
      paragraphs: ["auf Grundlage Ihres Verbrauchs haben wir Ihre monatlichen Abschläge neu berechnet. Die Beträge buchen wir jeweils zum 15. des Monats ab."],
      lines: [],
      totalCents: null,
      booking: null,
    });
  }

  if (inRange(at(6, 10))) {
    const total = rnd.int(1_400, 2_600) * 100;
    const [heat, water, care] = split(rnd, total, 3);
    push(b, {
      kind: "service_charges",
      date: at(6, 10),
      sender: CP.landlord,
      recipient: "both",
      subject: `Betriebskostenabrechnung ${year - 1}`,
      references: [{ label: "Mietobjekt", value: DEMO_HOUSEHOLD.address }, { label: "Mieternummer", value: "M-0001" }],
      paragraphs: ["anbei erhalten Sie die Abrechnung der Betriebskosten. Die Anteile für haushaltsnahe Dienstleistungen nach § 35a EStG sind gesondert ausgewiesen."],
      lines: [
        { text: "Heizung und Warmwasser", cents: heat },
        { text: "Wasser und Abwasser", cents: water },
        { text: "Hausmeister und Treppenhausreinigung (§ 35a)", cents: care },
        { text: "Vorauszahlungen", cents: -total },
      ],
      totalCents: 0,
      booking: null,
    });
  }

  for (const who of ["self", "spouse"] as const) {
    const date = at(7, who === "self" ? 3 : 8);
    if (!inRange(date)) continue;
    push(b, {
      kind: "pension_info",
      date,
      sender: CP.pensionFund,
      recipient: who,
      subject: "Ihre Renteninformation",
      references: [{ label: "Versicherungsnummer", value: who === "self" ? "00 000000 M 000" : "00 000000 E 000" }],
      paragraphs: [
        `Ihre bisher erreichte Rentenanwartschaft entspräche einer monatlichen Rente von ${euro(rnd.int(900, 1_600) * 100)}.`,
        "Diese Information wird Ihnen jährlich zugesandt. Bitte prüfen Sie, ob Ihr Versicherungsverlauf vollständig ist.",
      ],
      lines: [],
      totalCents: null,
      booking: null,
    });
  }

  if (inRange(at(11, 12))) {
    const premium = rnd.int(280, 520) * 100;
    push(b, {
      kind: "car_insurance",
      date: at(11, 12),
      sender: CP.carInsurer,
      recipient: "self",
      subject: `Beitragsrechnung Kfz-Versicherung ${year + 1}`,
      references: [{ label: "Versicherungsschein", value: "KF-000888" }, { label: "Kennzeichen", value: "ZZ-D 000" }],
      paragraphs: ["Ihr Beitrag für das kommende Versicherungsjahr. Wir buchen ihn zum 1. Januar ab."],
      lines: split(rnd, premium, 2).map((c, i) => ({ text: i === 0 ? "Kfz-Haftpflicht" : "Teilkasko", cents: c })),
      totalCents: premium,
      booking: null,
    });
  }
}

/**
 * Statements of each account listing the period's bookings: monthly for the
 * giro accounts, quarterly for the savings account. A period that is not
 * over yet has no statement.
 */
function statements(b: Builder): void {
  const { plan } = b;
  for (const account of plan.accounts) {
    const monthly = account.kind === "giro";
    let balance = account.openingCents;
    const periods = new Map<string, PlannedBooking[]>();
    for (const x of plan.bookings.filter((x) => x.account === account.key)) {
      const month = Number(x.date.slice(5, 7)) - 1;
      const key = `${x.date.slice(0, 4)}-${monthly ? month : Math.floor(month / 3)}`;
      if (!periods.has(key)) periods.set(key, []);
      periods.get(key)!.push(x);
    }
    let number = 0;
    for (const [key, rows] of periods) {
      const [y, n] = key.split("-").map(Number);
      // The month after the period's last one, 0-based; its first day minus one is the last day.
      const nextMonth = monthly ? n + 1 : n * 3 + 3;
      const lastDay = addDays(nextMonth === 12 ? `${y + 1}-01-01` : `${y}-${String(nextMonth + 1).padStart(2, "0")}-01`, -1);
      const opening = balance;
      balance += rows.reduce((s, x) => s + x.cents, 0);
      if (lastDay > plan.to) continue;
      number += 1;
      const period = monthly ? monthLabel(`${y}-${String(n + 1).padStart(2, "0")}-01`) : `${n + 1}. Quartal ${y}`;
      push(b, {
        kind: "bank_statement",
        date: addDays(lastDay, 1),
        sender: DEMO_BANK.name,
        recipient: account.owner === "spouse" ? "spouse" : account.owner === "both" ? "both" : "self",
        subject: `Kontoauszug Nr. ${number} ${period}`,
        references: [{ label: "Konto", value: account.label }, { label: "IBAN", value: formatIban(account) }, { label: "Zeitraum", value: period }],
        paragraphs: [],
        lines: [],
        totalCents: balance,
        statement: {
          opening,
          closing: balance,
          rows: rows.map((x) => ({ date: x.date, text: `${x.counterparty} ${x.purpose}`, cents: x.cents })),
          account: account.label,
          iban: formatIban(account),
        },
        booking: null,
      });
    }
  }
}

function formatIban(a: PlannedAccount): string {
  return a.iban.replace(/(.{4})/g, "$1 ").trim();
}

interface LetterKind {
  kind: DocKind;
  sender: string;
  recipient: Recipient;
  /** Subject and wording of each variant; `{date}` is a date a few weeks after the letter. */
  variants: Array<{ subject: string; paragraphs: string[] }>;
}

const LETTER_KINDS: LetterKind[] = [
  {
    kind: "school_letter",
    sender: CP.school,
    recipient: "both",
    variants: [
      { subject: "Elternbrief: Wandertag", paragraphs: ["am {date} unternimmt die Klasse von Kim einen Wandertag in den Stadtwald. Bitte geben Sie Ihrem Kind festes Schuhwerk, Regenkleidung und ein Pausenbrot mit.", "Treffpunkt ist um 8 Uhr auf dem Schulhof, zurück sind wir gegen 13 Uhr."] },
      { subject: "Einladung zum Elternabend", paragraphs: ["wir laden Sie herzlich zum Elternabend am {date} um 19:30 Uhr in den Klassenraum ein.", "Themen sind die Klassenfahrt, die Wahl der Elternvertretung und der Stundenplan."] },
      { subject: "Elternbrief: Schulfest", paragraphs: ["am {date} feiern wir unser Schulfest. Für das Kuchenbuffet freuen wir uns über Spenden.", "Bitte tragen Sie sich in die Liste am Klassenzimmer ein, wenn Sie beim Aufbau helfen können."] },
      { subject: "Information: Bewegliche Ferientage", paragraphs: ["die Schulkonferenz hat die beweglichen Ferientage festgelegt. Der erste ist der {date}.", "An diesen Tagen bietet der Hort eine Notbetreuung an; bitte melden Sie Ihr Kind bis eine Woche vorher an."] },
      { subject: "Elternbrief: Fotograf", paragraphs: ["am {date} kommt der Schulfotograf. Die Aufnahmen sind freiwillig; der Kauf der Bilder ist nicht verpflichtend.", "Bitte geben Sie die Einverständniserklärung unterschrieben zurück."] },
    ],
  },
  {
    kind: "club_letter",
    sender: CP.club,
    recipient: "self",
    variants: [
      { subject: "Einladung zur Mitgliederversammlung", paragraphs: ["der Vorstand lädt Sie herzlich zur ordentlichen Mitgliederversammlung am {date} um 19 Uhr ins Vereinsheim ein.", "Tagesordnung: Bericht des Vorstands, Kassenbericht, Entlastung, Wahlen, Verschiedenes."] },
      { subject: "Vereinsnachrichten", paragraphs: ["die Abteilung Tischtennis sucht Verstärkung für die neue Saison. Das erste Training findet am {date} statt.", "Außerdem wird der Sportplatz in den Ferien gesperrt, weil der Rasen erneuert wird."] },
      { subject: "Beitragsinformation", paragraphs: ["der Jahresbeitrag wird wie in jedem Jahr am {date} per Lastschrift eingezogen.", "Bitte teilen Sie uns eine geänderte Bankverbindung rechtzeitig mit."] },
      { subject: "Einladung zum Sommerfest", paragraphs: ["am {date} feiern wir auf dem Vereinsgelände unser Sommerfest mit Grill und Kinderturnier.", "Helferinnen und Helfer melden sich bitte bei der Geschäftsstelle."] },
    ],
  },
  {
    kind: "health_insurer_letter",
    sender: CP.healthInsurer,
    recipient: "spouse",
    variants: [
      { subject: "Ihr Bonusprogramm", paragraphs: ["mit unserem Bonusprogramm belohnen wir Ihre Vorsorge. Reichen Sie Ihr Bonusheft bis zum {date} ein.", "Die Prämie überweisen wir auf Ihr Konto."] },
      { subject: "Änderung des Zusatzbeitrags", paragraphs: ["unser Verwaltungsrat hat den kassenindividuellen Zusatzbeitrag neu festgesetzt. Er gilt ab dem {date}.", "Sie haben in diesem Fall ein Sonderkündigungsrecht."] },
      { subject: "Ihre neue Gesundheitskarte", paragraphs: ["anbei erhalten Sie Ihre neue elektronische Gesundheitskarte. Sie gilt ab dem {date}.", "Bitte vernichten Sie die alte Karte."] },
      { subject: "Erinnerung an die Vorsorgeuntersuchung", paragraphs: ["Ihnen steht in diesem Jahr wieder eine Vorsorgeuntersuchung zu. Vereinbaren Sie gern einen Termin bis zum {date}.", "Die Kosten übernehmen wir vollständig."] },
    ],
  },
  {
    kind: "price_change",
    sender: CP.utilities,
    recipient: "both",
    variants: [
      { subject: "Preisanpassung Strom", paragraphs: ["wir passen den Arbeitspreis Ihres Stromtarifs zum {date} an. Den neuen Abschlag teilen wir Ihnen gesondert mit.", "Sie haben ein Sonderkündigungsrecht zum Zeitpunkt der Änderung."] },
      { subject: "Preisanpassung Gas", paragraphs: ["wegen gestiegener Netzentgelte ändert sich Ihr Gaspreis zum {date}.", "Sie haben ein Sonderkündigungsrecht zum Zeitpunkt der Änderung."] },
      { subject: "Zählerablesung", paragraphs: ["unser Ableser kommt am {date} zwischen 8 und 16 Uhr. Bitte sorgen Sie dafür, dass die Zähler zugänglich sind.", "Alternativ können Sie uns die Zählerstände online mitteilen."] },
    ],
  },
  {
    kind: "bank_letter",
    sender: DEMO_BANK.name,
    recipient: "self",
    variants: [
      { subject: "Änderung unserer Entgelte", paragraphs: ["zum {date} ändern sich einzelne Entgelte im Preis- und Leistungsverzeichnis.", "Wenn Sie nicht bis dahin widersprechen, gilt Ihre Zustimmung als erteilt."] },
      { subject: "Ihr Freistellungsauftrag", paragraphs: ["bitte prüfen Sie, ob Ihr Freistellungsauftrag noch zu Ihren Erträgen passt. Änderungen nehmen wir bis zum {date} für das laufende Jahr an.", "Das Formular finden Sie im Online-Banking."] },
      { subject: "Neue Girocard", paragraphs: ["Ihre neue Girocard ist unterwegs. Die alte Karte bleibt bis zum {date} gültig.", "Ihre PIN bleibt unverändert."] },
    ],
  },
  {
    kind: "insurer_letter",
    sender: CP.insurer,
    recipient: "self",
    variants: [
      { subject: "Beitragsanpassung Ihrer Hausratversicherung", paragraphs: ["wegen der Entwicklung des Baupreisindex ändert sich Ihr Beitrag zum {date}.", "Ihr Versicherungsschutz bleibt unverändert."] },
      { subject: "Ihr Versicherungsschutz im Überblick", paragraphs: ["anbei erhalten Sie die aktuelle Übersicht Ihrer Verträge bei uns, Stand {date}.", "Bitte prüfen Sie, ob die Versicherungssumme noch zu Ihrem Hausrat passt."] },
    ],
  },
];

/**
 * Plans the documents for a household plan, filled with letters to the
 * size's target. `extra` are documents another planner made (the depot's
 * settlements and statements); they count toward the target. The order is
 * by date.
 */
export function planDocuments(seed: number, size: DemoSize, plan: HouseholdPlan, extra: DocumentDraft[] = []): DocumentPlan {
  const rnd = createRandom(seed ^ 0x5eed);
  const b: Builder = { rnd, plan, out: [], counter: new Map() };

  for (const d of extra) push(b, d);

  plan.bookings.forEach((booking, i) => fromBooking(b, i, booking));

  if (plan.from <= plan.to) {
    push(b, {
      kind: "rental_contract",
      date: plan.from,
      sender: CP.landlord,
      recipient: "both",
      subject: "Mietvertrag über Wohnraum (Nachtrag)",
      references: [{ label: "Mietobjekt", value: DEMO_HOUSEHOLD.address }],
      paragraphs: [
        "Zwischen der Vermieterin und den Mietern wird folgender Nachtrag zum Mietvertrag vereinbart.",
        `Die monatliche Grundmiete beträgt ab dem ${germanDate(plan.from)} ${euro(115_000)} einschließlich der Vorauszahlung auf die Betriebskosten.`,
      ],
      lines: [],
      totalCents: 115_000,
      booking: null,
    });
    push(b, {
      kind: "child_benefit_notice",
      date: addDays(plan.from, 5),
      sender: CP.familyFund,
      recipient: "both",
      subject: "Bescheid über Kindergeld",
      references: [{ label: "Kindergeldnummer", value: "000FK000000" }],
      paragraphs: [`Für Ihr Kind ${DEMO_HOUSEHOLD.child} wird Kindergeld in Höhe von ${euro(25_500)} monatlich festgesetzt.`, "Änderungen in Ihren Verhältnissen teilen Sie uns bitte unverzüglich mit."],
      lines: [],
      totalCents: 25_500,
      booking: null,
    });
  }

  for (let y = Number(plan.from.slice(0, 4)); y <= Number(plan.to.slice(0, 4)); y++) yearly(b, y, plan.from, plan.to);
  statements(b);

  const target = TARGET[size];
  let docs = b.out;
  if (docs.length > target) {
    // Small size: keep the ones that go with a booking first, then the rest by date.
    docs = [...docs].sort((x, y) => Number(y.booking !== null) - Number(x.booking !== null) || x.date.localeCompare(y.date) || x.key.localeCompare(y.key)).slice(0, target);
  } else {
    const firstDay = Date.parse(`${plan.from}T12:00:00Z`);
    const days = Math.max(0, Math.floor((Date.parse(`${plan.to}T12:00:00Z`) - firstDay) / 86_400_000));
    while (b.out.length < target) {
      const letter = rnd.pick(LETTER_KINDS);
      const variant = rnd.pick(letter.variants);
      const date = new Date(firstDay + rnd.int(0, days) * 86_400_000).toISOString().slice(0, 10);
      const when = germanDate(addDays(date, rnd.int(14, 45)));
      push(b, {
        kind: letter.kind,
        date,
        sender: letter.sender,
        recipient: letter.recipient,
        subject: variant.subject,
        references: [],
        paragraphs: variant.paragraphs.map((p) => p.replace("{date}", when)),
        lines: [],
        totalCents: null,
        booking: null,
      });
    }
    docs = b.out;
  }

  return { documents: [...docs].sort((x, y) => x.date.localeCompare(y.date) || x.key.localeCompare(y.key)) };
}

export function salutation(r: Recipient): string {
  if (r === "self") return "Sehr geehrter Herr Mustermann,";
  if (r === "spouse") return "Sehr geehrte Frau Mustermann,";
  return "Sehr geehrte Familie Mustermann,";
}
