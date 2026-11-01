/**
 * The household's meters and its small PV system (documentation/plans/
 * demodaten.md, stage 5), planned from the seed: monthly readings of grid
 * import, feed-in, PV production, gas and water over the household's span
 * from seasonal curves, the electricity tariffs the energy report prices
 * them with, the PV business with the system as its asset, and the
 * bookings of that business (feed-in payments, insurance, metering fee),
 * tagged so its EÜR shows them.
 *
 * The feed-in payments are the exported kWh of the month times the feed-in
 * tariff, so the EÜR's income line and the energy report's feed-in revenue
 * tell the same story.
 */

import type { MeterRole, MeterType } from "../db/schema";
import type { DemoSize, HouseholdPlan, PlannedBooking } from "./household";
import { DEMO_COUNTERPARTIES as CP } from "./names";
import { createRandom, type Random } from "./random";

export interface PlannedReading {
  /** ISO timestamp. */
  takenAt: string;
  value: number;
}

export interface PlannedMeter {
  key: "grid_import" | "grid_export" | "pv_production" | "gas" | "water";
  name: string;
  type: MeterType;
  role: MeterRole | null;
  unit: string;
  decimals: number;
  location: string;
  serialNumber: string;
  /** The device's counter when the span begins; the first reading repeats it. */
  startValue: number;
  readings: PlannedReading[];
}

export interface PlannedTariff {
  kind: "grid_import" | "base_price" | "feed_in";
  validFrom: string;
  amount: number;
  unit: "eur_per_kwh" | "eur_per_month";
  name: string;
}

export interface PlannedPv {
  name: string;
  capacityKwp: number;
  commissionedOn: string;
  /** What the system cost, VAT included (the household is no VAT payer). */
  costCents: number;
  /** Linear depreciation per year in percent. */
  afaRatePct: number;
}

export interface EnergyPlan {
  meters: PlannedMeter[];
  tariffs: PlannedTariff[];
  pv: PlannedPv;
  /** The PV business's bookings, each with the tags its EÜR reads. */
  bookings: PlannedBooking[];
}

/** kWh per kWp and month in central Europe, January first. */
const PV_YIELD = [22, 42, 78, 112, 130, 136, 134, 118, 88, 54, 26, 16];
/** Household demand in kWh per month without the PV system. */
const DEMAND = [390, 350, 330, 290, 270, 255, 260, 265, 280, 320, 360, 400];
/** Gas in m³ per month: heating and hot water. */
const GAS = [230, 200, 160, 100, 52, 26, 20, 20, 42, 100, 170, 220];
/** Water in m³ per month, more in summer (garden). */
const WATER = [8, 8, 9, 10, 12, 14, 15, 14, 11, 9, 8, 8];

export const PV_CAPACITY_KWP = 9.8;
/** EEG feed-in tariff of the system's commissioning, invented but plausible. */
export const FEED_IN_EUR_PER_KWH = 0.082;
const GRID_EUR_PER_KWH = 0.318;
const BASE_EUR_PER_MONTH = 11.9;
/** The PV system's tag; the PV business's EÜR reads bookings carrying it. */
export const PV_BOOKING_TAG = "Photovoltaik";

const MONTHS_DE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function noise(rnd: Random, spread: number): number {
  return 1 + (rnd.next() * 2 - 1) * spread;
}

function monthStart(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** The first of each month from `from` up to `to`, then `to` itself when it is not a first. */
function readingDays(from: string, to: string): string[] {
  const days: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7)) - 1;
  for (;;) {
    const d = monthStart(y, m);
    if (d > to) break;
    days.push(d);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  if (days.at(-1) !== to) days.push(to);
  return days;
}

/** Share of the month between two reading days, for the partial last month. */
function monthShare(a: string, b: string): number {
  const days = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
  const y = Number(a.slice(0, 4));
  const m = Number(a.slice(5, 7));
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.min(1, days / inMonth);
}

const at = (day: string) => `${day}T07:00:00.000Z`;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function planEnergy(seed: number, size: DemoSize, household: HouseholdPlan): EnergyPlan {
  const rnd = createRandom(seed ^ 0xe7e7);
  void size; // the span of the household decides how many readings there are
  const days = readingDays(household.from, household.to);
  const firstYear = Number(household.from.slice(0, 4));

  // The system went up two and a half years before the span: the meters
  // already count, and the depreciation started then.
  const pv: PlannedPv = {
    name: "PV-Anlage Dach",
    capacityKwp: PV_CAPACITY_KWP,
    commissionedOn: `${firstYear - 2}-05-20`,
    costCents: 1_699_320,
    afaRatePct: 5,
  };

  const counters = {
    grid_import: 18_000 + rnd.int(0, 4_000),
    grid_export: 14_000 + rnd.int(0, 2_000),
    pv_production: 21_000 + rnd.int(0, 2_000),
    gas: 9_000 + rnd.int(0, 2_000),
    water: 600 + rnd.int(0, 200),
  };
  const series: Record<PlannedMeter["key"], PlannedReading[]> = { grid_import: [], grid_export: [], pv_production: [], gas: [], water: [] };
  const exportByMonth: Array<{ month: string; kwh: number }> = [];
  const push = (key: PlannedMeter["key"], day: string) => series[key].push({ takenAt: at(day), value: round1(counters[key]) });
  for (const key of Object.keys(series) as PlannedMeter["key"][]) push(key, days[0]);

  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1];
    const month = Number(prev.slice(5, 7)) - 1;
    const share = monthShare(prev, days[i]);
    const produced = PV_CAPACITY_KWP * PV_YIELD[month] * noise(rnd, 0.15) * share;
    const demand = DEMAND[month] * noise(rnd, 0.08) * share;
    // About a third of what the roof makes is used in the house, never more than the house needs.
    const selfUsed = Math.min(produced * (0.28 + rnd.next() * 0.08), demand * 0.7);
    const exported = produced - selfUsed;
    counters.pv_production += produced;
    counters.grid_export += exported;
    counters.grid_import += demand - selfUsed;
    counters.gas += GAS[month] * noise(rnd, 0.12) * share;
    counters.water += WATER[month] * noise(rnd, 0.1) * share;
    for (const key of Object.keys(series) as PlannedMeter["key"][]) push(key, days[i]);
    if (share === 1) exportByMonth.push({ month: prev.slice(0, 7), kwh: exported });
  }

  const start = (key: PlannedMeter["key"]) => series[key][0].value;
  const meters: PlannedMeter[] = [
    { key: "grid_import", name: "Strom Bezug", type: "electricity", role: "grid_import", unit: "kWh", decimals: 0, location: "Keller, Zählerschrank", serialNumber: "1DEMO0000000001", startValue: start("grid_import"), readings: series.grid_import },
    { key: "grid_export", name: "Strom Einspeisung", type: "electricity", role: "grid_export", unit: "kWh", decimals: 0, location: "Keller, Zählerschrank", serialNumber: "1DEMO0000000002", startValue: start("grid_export"), readings: series.grid_export },
    { key: "pv_production", name: "PV Erzeugung", type: "electricity", role: "pv_production", unit: "kWh", decimals: 0, location: "Wechselrichter, Dachboden", serialNumber: "1DEMO0000000003", startValue: start("pv_production"), readings: series.pv_production },
    { key: "gas", name: "Gas", type: "gas", role: null, unit: "m³", decimals: 1, location: "Keller, Heizraum", serialNumber: "1DEMO0000000004", startValue: start("gas"), readings: series.gas },
    { key: "water", name: "Wasser", type: "water", role: "water_main", unit: "m³", decimals: 1, location: "Keller, Hausanschluss", serialNumber: "1DEMO0000000005", startValue: start("water"), readings: series.water },
  ];

  const tariffs: PlannedTariff[] = [
    { kind: "grid_import", validFrom: household.from, amount: GRID_EUR_PER_KWH, unit: "eur_per_kwh", name: "Strom Stadtwerke Musterstadt" },
    { kind: "base_price", validFrom: household.from, amount: BASE_EUR_PER_MONTH, unit: "eur_per_month", name: "Grundpreis Strom" },
    { kind: "feed_in", validFrom: pv.commissionedOn, amount: FEED_IN_EUR_PER_KWH, unit: "eur_per_kwh", name: "EEG-Vergütung PV-Anlage Dach" },
  ];

  // The grid operator pays each month's feed-in in the middle of the next.
  const bookings: PlannedBooking[] = [];
  const add = (b: Omit<PlannedBooking, "counterpartyIban" | "account" | "entryText"> & { entryText?: string }) => {
    if (b.date > household.to || b.date < household.from) return;
    bookings.push({ account: "giro_self", counterpartyIban: null, entryText: b.cents > 0 ? "Gutschrift" : "Lastschrift", ...b });
  };
  for (const e of exportByMonth) {
    const y = Number(e.month.slice(0, 4));
    const m = Number(e.month.slice(5, 7)) - 1;
    const paid = monthStart(y, m + 1).replace(/-01$/, "-15");
    add({
      date: paid,
      cents: Math.round(e.kwh * FEED_IN_EUR_PER_KWH * 100),
      counterparty: CP.gridOperator,
      purpose: `Einspeisevergütung ${MONTHS_DE[m]} ${y} Anlage 000PV000001 ${Math.round(e.kwh)} kWh`,
      kind: "pv_feed_in",
      tags: [PV_BOOKING_TAG, "Einspeisung"],
    });
  }
  for (let y = firstYear; y <= Number(household.to.slice(0, 4)); y++) {
    add({ date: `${y}-02-10`, cents: -rnd.int(85, 98) * 100, counterparty: CP.insurer, purpose: `Beitrag Photovoltaikversicherung ${y}`, kind: "pv_insurance", tags: [PV_BOOKING_TAG, "Versicherung"] });
    add({ date: `${y}-01-20`, cents: -rnd.int(55, 65) * 100, counterparty: CP.meterOperator, purpose: `Messstellenbetrieb Zweirichtungszähler ${y}`, kind: "pv_meter_fee", tags: [PV_BOOKING_TAG, "Zähler"] });
  }
  // One service visit in the second summer.
  add({ date: `${firstYear + 1}-07-08`, cents: -rnd.int(220, 290) * 100, counterparty: CP.solarInstaller, purpose: `Wartung PV-Anlage Rechnung WA-${firstYear + 1}-${rnd.int(100, 999)}`, entryText: "Überweisung", kind: "pv_service", tags: [PV_BOOKING_TAG, "Wartung"] });

  return { meters, tariffs, pv, bookings };
}
