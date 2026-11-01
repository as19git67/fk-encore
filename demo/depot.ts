/**
 * The depot of the demo household (documentation/plans/demodaten.md,
 * stage 3): four broad index funds at the demo bank, bought at the real
 * closing prices of the day, a monthly savings plan, distributions of the
 * two distributing funds, one sale, and a depot statement each quarter.
 * Every trade and payout is a booking on the admin's giro account and a
 * settlement PDF; the statements are PDFs only. No database here: the
 * closes come in, the bookings and document drafts go out.
 *
 * The depot transactions themselves are not written: the pipeline reads
 * them from the settlements and the holdings from the statements, as for
 * a depot whose papers were uploaded.
 *
 * The payouts per unit are synthetic (a yield on that day's price): the
 * provider has no payout history. Every paper says "Demodaten" in its
 * footer.
 */

import { createRandom, type Random } from "./random";
import { DEMO_BANK } from "./names";
import { euro, germanDate, type DepotPosition, type DocumentDraft } from "./documents";
import type { DemoSize, HouseholdPlan, PlannedBooking } from "./household";
import { DEMO_DEPOT_NUMBER, DEMO_SECURITIES, type DemoSecurity } from "./securities";

/** Closing prices per ISIN, by day (YYYY-MM-DD), in EUR. */
export type Closes = Map<string, Array<{ day: string; price: number }>>;

export interface DepotPlan {
  bookings: PlannedBooking[];
  documents: DocumentDraft[];
  /** What the depot holds at the end, per ISIN. */
  holdings: Map<string, number>;
}

const SAVINGS_PLAN_CENTS = 15_000;
const SAVINGS_PLAN_FEE_CENTS = 150;
const ORDER_FEE_CENTS = 490;

/** The close on `day` or the last one before it; `null` before the first close. */
export function closeOn(series: Array<{ day: string; price: number }>, day: string): { day: string; price: number } | null {
  let found: { day: string; price: number } | null = null;
  for (const c of series) {
    if (c.day > day) break;
    found = c;
  }
  return found;
}

function iso(y: number, m: number, d: number): string {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function quantity(q: number): string {
  return q.toLocaleString("de-DE", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function price(p: number): string {
  return `${p.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} EUR`;
}

function amount(cents: number): string {
  return euro(cents).replace(" €", " EUR");
}

interface Ctx {
  rnd: Random;
  from: string;
  to: string;
  closes: Closes;
  bookings: PlannedBooking[];
  documents: DocumentDraft[];
  held: Map<string, number>;
  order: number;
}

function booking(ctx: Ctx, date: string, cents: number, purpose: string): PlannedBooking {
  const b: PlannedBooking = {
    account: "giro_self",
    date,
    cents,
    counterparty: DEMO_BANK.name,
    counterpartyIban: null,
    purpose,
    entryText: "Wertpapiere",
    kind: "securities",
  };
  ctx.bookings.push(b);
  return b;
}

/** A buy or a sale at the day's close; `units` for a sale, `cents` to spend for a buy. */
function trade(ctx: Ctx, sec: DemoSecurity, date: string, side: "buy" | "sell", how: { cents?: number; units?: number; fee: number; plan?: boolean }): void {
  if (date < ctx.from || date > ctx.to) return;
  const close = closeOn(ctx.closes.get(sec.isin) ?? [], date);
  if (!close) return;
  const units = side === "buy"
    ? Math.floor(((how.cents! - how.fee) / 100 / close.price) * 1000) / 1000
    : Math.min(how.units!, ctx.held.get(sec.isin) ?? 0);
  if (units <= 0) return;
  const gross = Math.round(units * close.price * 100);
  const net = side === "buy" ? gross + how.fee : gross - how.fee;
  ctx.held.set(sec.isin, Math.round(((ctx.held.get(sec.isin) ?? 0) + (side === "buy" ? units : -units)) * 1000) / 1000);
  ctx.order += 1;
  const order = `${date.slice(0, 4)}${String(ctx.order).padStart(5, "0")}`;
  const word = side === "buy" ? "Kauf" : "Verkauf";
  const b = booking(ctx, date, side === "buy" ? -net : net, `Wertpapier${side === "buy" ? "kauf" : "verkauf"} ISIN ${sec.isin} Depot ${DEMO_DEPOT_NUMBER} Auftrag ${order}`);
  ctx.documents.push({
    kind: side === "buy" ? "securities_buy" : "securities_sell",
    date,
    sender: DEMO_BANK.name,
    recipient: "self",
    subject: `Wertpapierabrechnung ${word}${how.plan ? " aus Sparplan" : ""}`,
    references: [{ label: "Depotnummer", value: DEMO_DEPOT_NUMBER }, { label: "Auftragsnummer", value: order }],
    paragraphs: [`Wir haben für Sie ${side === "buy" ? "gekauft" : "verkauft"}. Den Gegenwert verrechnen wir mit Ihrem Konto.`],
    lines: [],
    facts: [
      { label: "Stück", value: quantity(units) },
      { label: "Wertpapierbezeichnung", value: sec.name },
      { label: "ISIN", value: sec.isin },
      { label: "Schlusstag", value: germanDate(date) },
      { label: "Ausführungskurs", value: price(close.price) },
      { label: "Kurswert", value: amount(gross) },
      { label: how.plan ? "Sparplangebühr" : "Provision", value: amount(how.fee) },
      ...(side === "sell" ? [{ label: "Steuern", value: "kein Steuerabzug (Freistellungsauftrag)" }] : []),
      { label: "Ausmachender Betrag", value: amount(net) },
      { label: "Valuta", value: germanDate(date) },
    ],
    totalCents: net,
    booking: null,
    bookingRef: b,
  });
}

function payout(ctx: Ctx, sec: DemoSecurity, date: string): void {
  if (!sec.payout || date < ctx.from || date > ctx.to) return;
  const units = ctx.held.get(sec.isin) ?? 0;
  const close = closeOn(ctx.closes.get(sec.isin) ?? [], date);
  if (units <= 0 || !close) return;
  const perUnit = Math.round((close.price * (sec.payout.yieldPct / 100) / sec.payout.perYear) * (0.85 + ctx.rnd.next() * 0.3) * 10_000) / 10_000;
  const gross = Math.round(units * perUnit * 100);
  if (gross <= 0) return;
  const b = booking(ctx, date, gross, `Ertragsgutschrift ISIN ${sec.isin} Depot ${DEMO_DEPOT_NUMBER}`);
  ctx.documents.push({
    kind: "distribution",
    date,
    sender: DEMO_BANK.name,
    recipient: "self",
    subject: "Ertragsgutschrift",
    references: [{ label: "Depotnummer", value: DEMO_DEPOT_NUMBER }],
    paragraphs: ["Wir haben Ihnen die Ausschüttung gutgeschrieben. Ein Steuerabzug war wegen Ihres Freistellungsauftrags nicht vorzunehmen."],
    lines: [],
    facts: [
      { label: "Wertpapierbezeichnung", value: sec.name },
      { label: "ISIN", value: sec.isin },
      { label: "Stück", value: quantity(units) },
      { label: "Ausschüttung pro Stück", value: price(perUnit) },
      { label: "Bruttobetrag", value: amount(gross) },
      { label: "Kapitalertragsteuer", value: amount(0) },
      { label: "Zahlbarkeitstag", value: germanDate(date) },
      { label: "Betrag zu Ihren Gunsten", value: amount(gross) },
    ],
    totalCents: gross,
    booking: null,
    bookingRef: b,
  });
}

function statement(ctx: Ctx, day: string): void {
  const positions: DepotPosition[] = [];
  for (const sec of DEMO_SECURITIES) {
    const units = ctx.held.get(sec.isin) ?? 0;
    const close = closeOn(ctx.closes.get(sec.isin) ?? [], day);
    if (units <= 0 || !close) continue;
    positions.push({ name: sec.name, isin: sec.isin, quantity: units, price: close.price, valueCents: Math.round(units * close.price * 100) });
  }
  if (!positions.length) return;
  const total = positions.reduce((s, p) => s + p.valueCents, 0);
  ctx.documents.push({
    kind: "depot_statement",
    date: day,
    sender: DEMO_BANK.name,
    recipient: "self",
    subject: `Depotauszug per ${germanDate(day)}`,
    references: [{ label: "Depot-Nr.", value: DEMO_DEPOT_NUMBER }],
    paragraphs: [`Ihr Depotbestand am ${germanDate(day)}. Depotwert gesamt ${amount(total)}.`],
    lines: [],
    positions,
    totalCents: total,
    booking: null,
  });
}

/**
 * Plans the depot over the household's time span. A security without a
 * close on a day is not traded that day; with no closes at all the depot
 * stays empty.
 */
export function planDepot(seed: number, size: DemoSize, plan: Pick<HouseholdPlan, "from" | "to">, closes: Closes): DepotPlan {
  const ctx: Ctx = { rnd: createRandom(seed ^ 0xde90), from: plan.from, to: plan.to, closes, bookings: [], documents: [], held: new Map(), order: 0 };
  const [world, em, europe, bonds] = DEMO_SECURITIES;
  const [fy, fm] = plan.from.split("-").map(Number);
  const [ty, tm] = plan.to.split("-").map(Number);
  const months = (ty - fy) * 12 + (tm - fm) + 1;

  // One-off buys in the first months, then the savings plan every month.
  const opening: Array<[DemoSecurity, number]> = size === "full" ? [[em, 0], [europe, 2], [bonds, 4]] : [[em, 0]];
  for (let i = 0; i < months; i++) {
    const y = fy + Math.floor((fm - 1 + i) / 12);
    const m = (fm - 1 + i) % 12;
    for (const [sec, at] of opening) {
      if (at === i) trade(ctx, sec, iso(y, m, 10), "buy", { cents: ctx.rnd.int(14, 22) * 10_000, fee: ORDER_FEE_CENTS });
    }
    trade(ctx, world, iso(y, m, 2), "buy", { cents: SAVINGS_PLAN_CENTS, fee: SAVINGS_PLAN_FEE_CENTS, plan: true });
    for (const sec of [europe, bonds]) {
      if (sec.payout?.months.includes(m)) payout(ctx, sec, iso(y, m, 20));
    }
    // Half of the Europe fund is sold once, two years in.
    if (size === "full" && i === 24) trade(ctx, europe, iso(y, m, 15), "sell", { units: Math.floor((ctx.held.get(europe.isin) ?? 0) / 2), fee: ORDER_FEE_CENTS });
    // A statement at each quarter's end that has passed.
    if (m % 3 === 2) {
      const end = iso(y, m, 31);
      if (end <= plan.to) statement(ctx, end);
    }
  }

  return { bookings: ctx.bookings, documents: ctx.documents, holdings: ctx.held };
}
