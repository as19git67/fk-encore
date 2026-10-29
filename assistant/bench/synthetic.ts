/**
 * The synthetic database of the assistant benchmark (stage 6, part 2 of
 * documentation/plans/assistent-wegfindung.md): a small, made-up household
 * — two accounts with bookings, two meters with readings, a handful of
 * documents with their text — owned by a benchmark account of its own, so a
 * run can measure the real tools (search, 0-row hints, follow-ups on real
 * ids) instead of canned results.
 *
 * Why an account of its own: the tools call the services through
 * `~encore/clients`, and Encore hands the caller's auth along, so the tools
 * of a run act as whoever the run runs as. Seeding the data under the
 * benchmark account and running as that account keeps a run away from
 * anyone's real data, and keeps real data out of the measurement.
 *
 * Every row the seeder writes carries the account as owner, and every
 * top-level row is registered in `assistant_benchmark_seed`, so
 * `removeSyntheticData` takes back exactly what was laid down. The dataset is
 * fixed and every name, number and amount in it is invented.
 */

import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { finance } from "~encore/clients";
import db from "../../db/database";
import {
  assistantBenchmarkSeed,
  documentCategories,
  documents,
  documentTaxSections,
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeTag,
  financeTagTransaction,
  financeTransaction,
  meterDevices,
  meterReadings,
  meters,
  users,
} from "../../db/schema";
import { resolveCorrespondent } from "../../documents/correspondent";
import type { AssistantUser, ChatMessage } from "../types";
import type { BenchCase } from "./cases";

/** The account the synthetic runs run as. It cannot log in. */
export const BENCH_ACCOUNT_EMAIL = "assistant-benchmark@system.local";
export const BENCH_ACCOUNT_NAME = "Assistent-Benchmark";
const NO_LOGIN_HASH = "$2a$10$NOLOGIN.SYSTEM.USER.ASSISTANT.BENCHMARK.0000000000000";

/** Finds or creates the benchmark account and returns its id. */
export async function ensureBenchAccount(): Promise<number> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, BENCH_ACCOUNT_EMAIL)).limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(users)
    .values({ email: BENCH_ACCOUNT_EMAIL, name: BENCH_ACCOUNT_NAME, password_hash: NO_LOGIN_HASH })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (row) return row.id;
  const [again] = await db.select({ id: users.id }).from(users).where(eq(users.email, BENCH_ACCOUNT_EMAIL)).limit(1);
  return again.id;
}

/** The benchmark account as the assistant sees a user: its id, every permission the tools need. */
export function benchAccountUser(id: number, permissions: string[]): AssistantUser {
  return { userID: String(id), permissions };
}

// ── the dataset ───────────────────────────────────────────────────────────

const GIRO_LABEL = "Girokonto Beispielbank";
const SAVINGS_LABEL = "Tagesgeld Beispielbank";

interface BookingSeed {
  key: string;
  date: string;
  amount: string;
  counterparty: string;
  purpose: string;
  tags?: string[];
  tax?: boolean;
}

/** Bookings on the giro account. "Today" of the benchmark is 2026-10-15. */
const BOOKINGS: BookingSeed[] = [
  { key: "baumarkt-1", date: "2026-09-03", amount: "-45.90", counterparty: "Beispiel Baumarkt", purpose: "Schrauben und Dübel" },
  { key: "baumarkt-2", date: "2026-09-12", amount: "-120.00", counterparty: "Beispiel Baumarkt", purpose: "Farbe Wohnzimmer" },
  { key: "baumarkt-3", date: "2026-09-27", amount: "-19.99", counterparty: "Beispiel Baumarkt", purpose: "Pinsel und Abdeckfolie" },
  { key: "strom-08", date: "2026-08-14", amount: "-89.00", counterparty: "Musterstrom GmbH", purpose: "Abschlag Strom 08/2026", tags: ["Energie"] },
  { key: "strom-09", date: "2026-09-14", amount: "-89.00", counterparty: "Musterstrom GmbH", purpose: "Abschlag Strom 09/2026", tags: ["Energie"] },
  { key: "strom-10", date: "2026-10-01", amount: "-89.00", counterparty: "Musterstrom GmbH", purpose: "Abschlag Strom 10/2026", tags: ["Energie"] },
  { key: "gehalt-08", date: "2026-08-31", amount: "2800.00", counterparty: "Beispiel Arbeitgeber AG", purpose: "Gehalt August 2026" },
  { key: "gehalt-09", date: "2026-09-30", amount: "2800.00", counterparty: "Beispiel Arbeitgeber AG", purpose: "Gehalt September 2026" },
  { key: "hausrat", date: "2026-09-05", amount: "-60.00", counterparty: "Muster Versicherung AG", purpose: "Hausratversicherung HV-0000123 Beitrag", tags: ["Versicherung"], tax: false },
  { key: "buecher", date: "2026-07-20", amount: "-35.50", counterparty: "Beispiel Buchhandlung", purpose: "Bücher" },
  { key: "spende", date: "2025-12-10", amount: "-150.00", counterparty: "Beispielverein e. V.", purpose: "Spende", tax: true },
];

/** What the Baumarkt bookings of September 2026 add up to, as the answer should say it. */
export const BAUMARKT_SEPTEMBER_SUM = "185,89";

interface MeterSeed {
  key: "strom" | "wasser";
  name: string;
  type: "electricity" | "water";
  unit: string;
  role: "grid_import" | null;
  decimals: number;
  startValue: string;
  /** Readings as [date, absolute value]. */
  readings: Array<[string, string]>;
}

const METERS: MeterSeed[] = [
  {
    key: "strom", name: "Strom Haus", type: "electricity", unit: "kWh", role: "grid_import", decimals: 0, startValue: "10000",
    readings: [["2025-01-01", "10000"], ["2025-07-01", "11800"], ["2026-01-01", "13500"], ["2026-10-01", "16200"]],
  },
  {
    key: "wasser", name: "Wasser Haus", type: "water", unit: "m³", role: null, decimals: 1, startValue: "500",
    readings: [["2025-01-01", "500.0"], ["2026-01-01", "620.0"], ["2026-10-01", "710.5"]],
  },
];

interface DocumentSeed {
  key: "heizung" | "ersatzteil" | "hausrat" | "mahnung" | "spende" | "lohnsteuer" | "kontoauszug";
  title: string;
  sender: string;
  date: string;
  category: string | null;
  type: string;
  text: string;
  summary: string;
  tax?: { year: number; sections: string[] };
}

/** The text a letter, a dunning notice or an invoice carries; every value in it is made up. */
export const MAHNUNG_DEADLINE = "30.10.2026";

const DOCUMENTS: DocumentSeed[] = [
  {
    key: "heizung", title: "Rechnung Heizungswartung", sender: "Musterfirma Haustechnik GmbH", date: "2026-09-02",
    category: "finanzen-rechnungen", type: "rechnung",
    text: "Musterfirma Haustechnik GmbH · Beispielstraße 1 · 12345 Musterstadt\n\nRechnung RE-2026-0101 vom 02.09.2026\n\nJährliche Wartung der Gasheizung am 28.08.2026 inkl. Abgasmessung.\nArbeitszeit 1,5 h: 98,00 €\nKleinmaterial: 3,24 €\nUmsatzsteuer 19 %: 19,26 €\nRechnungsbetrag: 120,50 €\nZahlbar bis 16.09.2026.",
    summary: "Rechnung über die jährliche Wartung der Gasheizung, 120,50 €.",
  },
  {
    key: "ersatzteil", title: "Rechnung Ersatzteil Heizung", sender: "Musterfirma Haustechnik GmbH", date: "2026-09-09",
    category: "finanzen-rechnungen", type: "rechnung",
    text: "Musterfirma Haustechnik GmbH\n\nRechnung RE-2026-0102 vom 09.09.2026\n\nErsatz des Ausdehnungsgefäßes der Heizung.\nMaterial: 64,90 €\nMontage: 25,00 €\nRechnungsbetrag: 89,90 €",
    summary: "Rechnung für das Ausdehnungsgefäß der Heizung, 89,90 €.",
  },
  {
    key: "hausrat", title: "Beitragsrechnung Hausratversicherung", sender: "Muster Versicherung AG", date: "2026-01-10",
    category: "wohnen-versicherung", type: "beitragsrechnung",
    text: "Muster Versicherung AG\n\nHausratversicherung, Vertrag HV-0000123\nBeitragsrechnung für 2026\nJahresbeitrag: 240,00 €, zahlbar in monatlichen Raten von 20,00 € zuzüglich Versicherungssteuer.",
    summary: "Jahresbeitrag der Hausratversicherung 2026, Vertrag HV-0000123.",
  },
  {
    key: "mahnung", title: "Mahnung Beispiel Versand", sender: "Beispiel Versand GmbH", date: "2026-10-02",
    category: "finanzen-rechnungen", type: "mahnung",
    text: `Beispiel Versand GmbH · Beispielstraße 1 · 12345 Musterstadt\n\nMahnung\n\nZu unserer Rechnung BV-77-0042 vom 01.09.2026 über 59,90 € konnten wir noch keinen Zahlungseingang feststellen. Bitte überweisen Sie den Betrag bis zum ${MAHNUNG_DEADLINE}.`,
    summary: "Mahnung zur Rechnung BV-77-0042 über 59,90 €.",
  },
  {
    key: "spende", title: "Zuwendungsbestätigung 2025", sender: "Beispielverein e. V.", date: "2026-01-20",
    category: "finanzen-spenden", type: "spendenbescheinigung",
    text: "Beispielverein e. V.\n\nBestätigung über Geldzuwendungen\n\nWir bestätigen den Erhalt einer Spende von 150,00 € am 10.12.2025. Die Zuwendung wird für steuerbegünstigte Zwecke verwendet.",
    summary: "Spendenbescheinigung über 150,00 € für 2025.",
    tax: { year: 2025, sections: ["sonderausgaben"] },
  },
  {
    key: "lohnsteuer", title: "Lohnsteuerbescheinigung 2025", sender: "Beispiel Arbeitgeber AG", date: "2026-02-01",
    category: "finanzen-gehalt", type: "lohnsteuerbescheinigung",
    text: "Beispiel Arbeitgeber AG\n\nAusdruck der elektronischen Lohnsteuerbescheinigung für 2025\nBruttoarbeitslohn: 42.000,00 €\nEinbehaltene Lohnsteuer: 5.600,00 €",
    summary: "Lohnsteuerbescheinigung 2025 des Arbeitgebers.",
    tax: { year: 2025, sections: ["anlage-n"] },
  },
  {
    key: "kontoauszug", title: "Kontoauszug Tagesgeld Juni 2026", sender: "Beispielbank", date: "2026-06-30",
    category: "finanzen-kontoauszuege", type: "kontoauszug",
    text: "Beispielbank\n\nKontoauszug Tagesgeldkonto, Juni 2026\nZinsgutschrift 12,50 €\nSaldo neu: 10.000,00 €",
    summary: "Kontoauszug des Tagesgeldkontos für Juni 2026.",
  },
];

/** The ids the seeder assigned, for the cases that name one. */
export interface SeedIds {
  owner: number;
  accounts: { giro: number; savings: number };
  bookings: Record<string, number>;
  meters: Record<MeterSeed["key"], number>;
  documents: Record<DocumentSeed["key"], number>;
}

function sha(key: string): string {
  return crypto.createHash("sha256").update(`assistant-benchmark:${key}`).digest("hex");
}

async function register(table: string, ids: number[]): Promise<void> {
  if (!ids.length) return;
  await db.insert(assistantBenchmarkSeed).values(ids.map((row_id) => ({ table_name: table, row_id })));
}

async function registered(table: string): Promise<number[]> {
  const rows = await db.select({ row_id: assistantBenchmarkSeed.row_id }).from(assistantBenchmarkSeed).where(eq(assistantBenchmarkSeed.table_name, table));
  return rows.map((r) => r.row_id);
}

/**
 * Lays the dataset down afresh for the benchmark account: what an earlier
 * run left is removed first, so the ids are new and the rows are exactly the
 * dataset. Returns the ids the cases need.
 */
export async function seedSyntheticData(ownerId: number): Promise<SeedIds> {
  await removeSyntheticData();

  // ── finance ──
  const types = await db.select({ id: financeAccountType.id, kind: financeAccountType.kind }).from(financeAccountType);
  const typeId = (kind: string) => {
    const t = types.find((x) => x.kind === kind) ?? types[0];
    if (!t) throw new Error("finance_account_type is empty — the seed has not run");
    return t.id;
  };
  const [giro] = await db
    .insert(financeAccount)
    .values({ type_id: typeId("giro"), currency_code: "EUR", account_number: "0000001234", label: GIRO_LABEL })
    .returning({ id: financeAccount.id });
  const [savings] = await db
    .insert(financeAccount)
    .values({ type_id: typeId("tagesgeld"), currency_code: "EUR", account_number: "0000005678", label: SAVINGS_LABEL })
    .returning({ id: financeAccount.id });
  await register("finance_account", [giro.id, savings.id]);
  await db.insert(financeAccountAccess).values([
    { account_id: giro.id, user_id: ownerId, level: "write" },
    { account_id: savings.id, user_id: ownerId, level: "write" },
  ]);
  await db.insert(financeAccountBalance).values([
    { account_id: giro.id, as_of: "2026-10-14T18:00:00Z", balance: "2345.67", source: "manual" },
    { account_id: savings.id, as_of: "2026-10-14T18:00:00Z", balance: "10000.00", source: "manual" },
  ]);

  const bookingIds: Record<string, number> = {};
  for (const b of BOOKINGS) {
    const [row] = await db
      .insert(financeTransaction)
      .values({
        account_id: giro.id,
        booking_date: `${b.date}T00:00:00`,
        value_date: `${b.date}T00:00:00`,
        amount: b.amount,
        currency_code: "EUR",
        purpose: b.purpose,
        counterparty: b.counterparty,
        entry_text: Number(b.amount) < 0 ? "Lastschrift" : "Gutschrift",
        is_tax_relevant: b.tax ?? false,
        dedupe_hash: sha(`booking:${b.key}`),
      })
      .returning({ id: financeTransaction.id });
    bookingIds[b.key] = row.id;
  }

  // Tags are shared by name: one the household already has is used and left
  // alone afterwards; one the seeder creates is registered and removed again.
  const tagNames = [...new Set(BOOKINGS.flatMap((b) => b.tags ?? []))];
  const tagIds = new Map<string, number>();
  for (const name of tagNames) {
    const [created] = await db.insert(financeTag).values({ name, source: "user" }).onConflictDoNothing().returning({ id: financeTag.id });
    if (created) {
      await register("finance_tag", [created.id]);
      tagIds.set(name, created.id);
    } else {
      const [existing] = await db.select({ id: financeTag.id }).from(financeTag).where(and(eq(financeTag.name, name), eq(financeTag.source, "user"))).limit(1);
      tagIds.set(name, existing.id);
    }
  }
  const links = BOOKINGS.flatMap((b) => (b.tags ?? []).map((t) => ({ tag_id: tagIds.get(t)!, transaction_id: bookingIds[b.key] })));
  if (links.length) await db.insert(financeTagTransaction).values(links);

  // ── meters ──
  const meterIds = {} as Record<MeterSeed["key"], number>;
  for (const m of METERS) {
    const [meter] = await db
      .insert(meters)
      .values({ name: m.name, type: m.type, unit: m.unit, role: m.role, decimals: m.decimals, owner_user_id: ownerId, location: "Keller" })
      .returning({ id: meters.id });
    meterIds[m.key] = meter.id;
    const [device] = await db
      .insert(meterDevices)
      .values({ meter_id: meter.id, installed_at: "2024-12-31T12:00:00Z", start_value: m.startValue, serial_number: `BENCH-${m.key.toUpperCase()}` })
      .returning({ id: meterDevices.id });
    await db.insert(meterReadings).values(
      m.readings.map(([date, value]) => ({ device_id: device.id, value, taken_at: `${date}T00:00:00Z`, source: "manual" as const, entered_by: ownerId })),
    );
  }
  await register("meters", Object.values(meterIds));

  // ── documents ──
  const slugs = [...new Set(DOCUMENTS.map((d) => d.category).filter((s): s is string => s !== null))];
  const categories = slugs.length
    ? await db.select({ id: documentCategories.id, slug: documentCategories.slug }).from(documentCategories).where(inArray(documentCategories.slug, slugs))
    : [];
  const categoryId = (slug: string | null) => categories.find((c) => c.slug === slug)?.id ?? null;
  const documentIds = {} as Record<DocumentSeed["key"], number>;
  for (const d of DOCUMENTS) {
    const who = resolveCorrespondent(d.sender);
    const [row] = await db
      .insert(documents)
      .values({
        user_id: ownerId,
        sha256: sha(`document:${d.key}`),
        original_filename: `${d.key}.pdf`,
        mime_type: "application/pdf",
        size_bytes: Buffer.byteLength(d.text, "utf8"),
        // No file behind it: the benchmark reads text and metadata, never the PDF.
        disk_path: `assistant-benchmark/${d.key}.pdf`,
        status: "ready",
        category_id: categoryId(d.category),
        title: d.title,
        doc_date: d.date,
        sender: d.sender,
        correspondent_slug: who?.slug ?? null,
        correspondent_display: who?.display ?? null,
        summary: d.summary,
        extracted_text: d.text,
        document_type: d.type,
        classification_confidence: 0.95,
        attributes_reviewed: true,
        tax_relevant: d.tax !== undefined,
        tax_role: d.tax ? "beleg" : "keine",
        tax_year: d.tax?.year ?? null,
        tax_reviewed: d.tax !== undefined,
        visibility: "private",
        pages_total: 1,
        pages_ocred: 1,
        text_source: "text_layer",
      })
      .returning({ id: documents.id });
    documentIds[d.key] = row.id;
    if (d.tax) {
      await db.insert(documentTaxSections).values(d.tax.sections.map((s) => ({ document_id: row.id, tax_section: s, confidence: 1, source: "user" as const })));
    }
  }
  await register("documents", Object.values(documentIds));

  return { owner: ownerId, accounts: { giro: giro.id, savings: savings.id }, bookings: bookingIds, meters: meterIds, documents: documentIds };
}

/** Takes back every row a seeding registered; children fall with their parent. */
export async function removeSyntheticData(): Promise<void> {
  const accounts = await registered("finance_account");
  if (accounts.length) {
    // Bookings do not cascade from their account (restrict): first them, then the account with its access and balances.
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, accounts));
    await db.delete(financeAccount).where(inArray(financeAccount.id, accounts));
  }
  const tags = await registered("finance_tag");
  if (tags.length) await db.delete(financeTag).where(inArray(financeTag.id, tags));
  const meterRows = await registered("meters");
  if (meterRows.length) await db.delete(meters).where(inArray(meters.id, meterRows));
  const docs = await registered("documents");
  if (docs.length) await db.delete(documents).where(inArray(documents.id, docs));
  await db.delete(assistantBenchmarkSeed);
}

/** How many top-level rows are registered right now — what "remove" would take back. */
export async function syntheticRowCount(): Promise<number> {
  const rows = await db.select({ id: assistantBenchmarkSeed.id }).from(assistantBenchmarkSeed);
  return rows.length;
}

// ── the cases ─────────────────────────────────────────────────────────────

/** An earlier turn as the assistant replays it, with the ids the seeder assigned. */
function earlierTurn(question: string, tool: string, args: Record<string, unknown>, ids: number[], answer: string): ChatMessage[] {
  const id = `h-${tool}`;
  return [
    { role: "user", content: question },
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, content: `[earlier result of ${tool}: ${ids.length} rows, ids ${ids.join(",")}]` },
    { role: "assistant", content: answer },
  ];
}

/** The ids before a seeding: every case can be listed, none can run. */
export const UNSEEDED: SeedIds = {
  owner: 0,
  accounts: { giro: 0, savings: 0 },
  bookings: {},
  meters: { strom: 0, wasser: 0 },
  documents: { heizung: 0, ersatzteil: 0, hausrat: 0, mahnung: 0, spende: 0, lohnsteuer: 0, kontoauszug: 0 },
};

/**
 * The cases that run against the synthetic data. Their expectations name
 * content — a counterparty, a period, a sum, a deadline — never an id the
 * sequences assign, except where a tool takes one the seeder handed out
 * (a meter, the documents of an earlier turn). `results` stays empty: the
 * real tools answer.
 */
export function syntheticCases(ids: SeedIds): BenchCase[] {
  const heizung = [ids.documents.heizung, ids.documents.ersatzteil];
  return [
    {
      id: "syn-accounts",
      title: "Synthetisch: Konten auflisten",
      question: "Welche Konten habe ich?",
      expect: [{ tool: "list_accounts" }],
      answerMatches: "Girokonto",
      results: {},
    },
    {
      id: "syn-baumarkt-sum",
      title: "Synthetisch: Summe der Baumarkt-Ausgaben im September",
      question: "Was habe ich im September 2026 beim Baumarkt ausgegeben?",
      expect: [{ tool: "transaction_totals", args: { q: { $contains: "baumarkt" }, from: { $contains: "2026-09" } } }],
      firstTools: ["transaction_totals", "list_transactions"],
      answerMatches: BAUMARKT_SEPTEMBER_SUM.replace(",", "[,.]"),
      results: {},
    },
    {
      id: "syn-strom-empty-month",
      title: "Synthetisch: leere Trefferliste (kein Abschlag im Juli), dann gelockert",
      question: "Zeig mir die Buchungen von Musterstrom im Juli 2026.",
      expect: [{ tool: "list_transactions", args: { q: { $contains: "musterstrom" } } }],
      // Nothing in July; the answer says so and names what the loosened call found.
      answerMatches: "Juli",
      results: {},
    },
    {
      id: "syn-salary",
      title: "Synthetisch: Einnahmen vom Arbeitgeber",
      question: "Wie viel Gehalt habe ich im September 2026 bekommen?",
      expect: [{ tool: "list_transactions", args: { q: { $contains: "gehalt" } }, anyOf: [{ q: { $contains: "arbeitgeber" } }, { direction: "in", from: { $contains: "2026-09" } }] }],
      firstTools: ["list_transactions", "transaction_totals"],
      answerMatches: "2[.\\s]?800",
      results: {},
    },
    {
      id: "syn-strom-2025",
      title: "Synthetisch: Stromverbrauch 2025 über den echten Zählerbericht",
      question: "Wie viel Strom haben wir 2025 verbraucht?",
      expect: [
        { tool: "list_meters" },
        { tool: "consumption_report", args: { meter_id: ids.meters.strom, from: { $contains: "2025" } } },
      ],
      firstTools: ["list_meters"],
      // 3,500 kWh between the readings at the turn of each year; the yearly
      // bucket may interpolate a few kWh either way at the boundaries.
      answerMatches: "3[.\\s]?[45]\\d\\d",
      results: {},
    },
    {
      id: "syn-invoice-search",
      title: "Synthetisch: Rechnung über die Volltextsuche finden",
      question: "Finde die Rechnung für die Heizungswartung.",
      expect: [{ tool: "search_documents", args: { q: { $contains: "heizung" } } }],
      answerMatches: "Heizungswartung|120[,.]50",
      results: {},
    },
    {
      id: "syn-insurer-documents",
      title: "Synthetisch: Dokumente eines Absenders",
      question: "Welche Dokumente habe ich von der Muster Versicherung?",
      expect: [{ tool: "search_documents", args: { correspondent: { $contains: "versicherung" } }, anyOf: [{ q: { $contains: "versicherung" } }] }],
      answerMatches: "Hausrat",
      results: {},
    },
    {
      id: "syn-tax-2025",
      title: "Synthetisch: Belege für die Steuer 2025",
      question: "Welche Belege habe ich für die Steuer 2025?",
      expect: [{ tool: "tax_documents", args: { year: 2025 } }],
      answerMatches: "Zuwendung|Spende|Lohnsteuer",
      results: {},
    },
    {
      id: "syn-mahnung-deadline",
      title: "Synthetisch: Frist aus dem Text der Mahnung",
      question: "Bis wann muss ich die Mahnung von Beispiel Versand bezahlen?",
      expect: [
        { tool: "search_documents", args: { q: { $contains: "mahnung" } }, anyOf: [{ correspondent: { $contains: "versand" } }] },
        { tool: "get_document_text", args: { id: ids.documents.mahnung } },
      ],
      answerMatches: MAHNUNG_DEADLINE.replace(/\./g, "\\.") + "|30\\. Oktober 2026",
      results: {},
    },
    {
      id: "syn-follow-up-documents",
      title: "Synthetisch: Rückfrage auf die Dokumente der vorigen Antwort",
      question: "Worum geht es in der ersten davon genau?",
      history: earlierTurn(
        "Zeig mir die Rechnungen der Musterfirma Haustechnik.",
        "search_documents", { correspondent: "Musterfirma Haustechnik" },
        heizung,
        "Von der Musterfirma Haustechnik gibt es zwei Rechnungen: die Heizungswartung vom 02.09.2026 und das Ersatzteil vom 09.09.2026.",
      ),
      previous: { document: heizung },
      expect: [{ tool: "get_document_summary", args: { id: ids.documents.heizung }, anyOf: [{ ids: { $contains: String(ids.documents.heizung) } }] }],
      firstTools: ["get_document_summary", "get_document_text"],
      answerMatches: "Wartung|Gasheizung|120[,.]50",
      results: {},
    },
  ];
}

/** The labels the self-check of a run looks for: the seeded accounts, as the tools would list them. */
export const SEEDED_ACCOUNT_LABELS = [GIRO_LABEL, SAVINGS_LABEL];

/**
 * Checks that the run acts as the benchmark account: the accounts the
 * seeder laid down must come back through the finance service, which
 * filters by the caller's access list. Anything else — the admin's
 * accounts, or none — means the auth was not handed over, and the run
 * stops before it reads anyone's real data.
 */
export async function verifySight(): Promise<void> {
  const res = (await finance.listAccounts()) as unknown as { items: Array<{ label: string }> };
  const labels = res.items.map((a) => a.label);
  const missing = SEEDED_ACCOUNT_LABELS.filter((l) => !labels.includes(l));
  const foreign = labels.filter((l) => !SEEDED_ACCOUNT_LABELS.includes(l));
  if (missing.length || foreign.length) {
    throw new Error(
      `the run does not act as the benchmark account: the finance service lists ${labels.length} account(s)` +
        (missing.length ? `, missing ${missing.map((l) => `"${l}"`).join(", ")}` : "") +
        (foreign.length ? `, and ${foreign.length} that the benchmark did not seed` : "") +
        " — the auth hand-over of the internal call did not reach the tools",
    );
  }
}
