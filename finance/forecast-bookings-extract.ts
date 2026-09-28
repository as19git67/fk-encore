// Retirement forecast — what bookings say about a contract item (pure).
//
// A premium that is paid shows up as a booking. Once bookings are linked to
// an item, their rhythm and last amount tell what the contract really
// costs, and the difference to the item becomes a proposal like one from a
// statement. The service (forecast-bookings.service.ts) finds and links the
// bookings; everything here is arithmetic on what it found.

import type { ItemType } from "./forecast-engine";
import type { Proposal } from "./forecast-statements-extract";

type Data = Record<string, unknown>;

const num = (d: Data, k: string): number | null => (typeof d[k] === "number" ? (d[k] as number) : null);

/** Words that name a kind of insurance, in labels and in documents. */
const KIND_WORDS = [
  "haftpflicht",
  "rechtsschutz",
  "hausrat",
  "wohngebäude",
  "gebäude",
  "kfz",
  "auto",
  "reise",
  "unfall",
  "berufsunfähigkeit",
  "zusatz",
  "pflege",
  "zahn",
  "risikoleben",
  "lebensversicherung",
  "rentenversicherung",
  "krankenversicherung",
  "versicherung",
];

const INSURANCE_RE = /versicher|haftpflicht|rechtsschutz|hausrat|geb(ä|ae)ude|kfz|reise|unfall|zusatz|pflege|\bbu\b|\bkv\b|\bpv\b|risiko/i;

/** Items whose premiums and documents the forecast looks for. */
export function isInsuranceItem(type: ItemType, label: string, data: Data): boolean {
  if (type === "life_insurance" || type === "pension" || type === "health_insurance") return true;
  if (typeof data.contractNo === "string" && data.contractNo.trim()) return true;
  if (typeof data.insurer === "string" && data.insurer.trim()) return true;
  return (type === "expense" || type === "income") && INSURANCE_RE.test(label);
}

/** The kinds of insurance a label names ("Privathaftpflicht" → "haftpflicht"). */
export function kindWords(label: string): string[] {
  const l = label.toLowerCase();
  const found = KIND_WORDS.filter((w) => w !== "versicherung" && l.includes(w));
  // "gebäude" is contained in "wohngebäude"; keep the longer one only.
  return found.filter((w) => !found.some((o) => o !== w && o.includes(w)));
}

const STOP = new Set(["und", "der", "die", "das", "für", "fuer", "privat", "alt", "neu", "vertrag"]);

/**
 * Words that may name the insurer in a booking's counterparty: the insurer
 * field first, else the words of the label that are neither a kind of
 * insurance nor filler ("Rechtsschutz Beispiel AG" → "beispiel").
 */
export function nameTokens(insurer: unknown, label: string): string[] {
  const source = typeof insurer === "string" && insurer.trim() ? insurer : label;
  const words = source
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !KIND_WORDS.some((k) => w.includes(k) || k.includes(w)));
  const legal = new Set(["gmbh", "versicherungsverein", "aktiengesellschaft", "versicherungen"]);
  return [...new Set(words.filter((w) => !legal.has(w)))].slice(0, 3);
}

/** What the item expects to pay per year, or null when it names no premium. */
export function expectedPerYear(type: ItemType, data: Data): number | null {
  switch (type) {
    case "expense": {
      const a = num(data, "amount");
      if (a == null) return null;
      return data.frequency === "yearly" ? a : data.frequency === "once" ? null : a * 12;
    }
    case "life_insurance":
      return num(data, "monthlyPremium") != null ? num(data, "monthlyPremium")! * 12 : null;
    case "pension":
      return num(data, "monthlyContribution") != null ? num(data, "monthlyContribution")! * 12 : null;
    case "health_insurance":
      return num(data, "employedAmount") != null ? num(data, "employedAmount")! * 12 : null;
    default:
      return null;
  }
}

/** A booking of this size fits the expected premium paid monthly, quarterly, half-yearly or yearly (±20 %). */
export function fitsPremium(amount: number, perYear: number | null): boolean {
  if (perYear == null || perYear <= 0) return false;
  const a = Math.abs(amount);
  return [12, 4, 2, 1].some((n) => Math.abs(a - perYear / n) <= (perYear / n) * 0.2);
}

export type Rhythm = "monthly" | "quarterly" | "halfyearly" | "yearly" | "irregular";

export interface BookingSummary {
  rhythm: Rhythm;
  /** Payments per year of that rhythm; 1 when irregular. */
  perYearCount: number;
  lastAmount: number;
  lastDate: string;
  /** The last amount times the rhythm: what a year costs now. */
  perYear: number;
  count: number;
}

const RHYTHMS: Array<{ rhythm: Rhythm; days: number; count: number }> = [
  { rhythm: "monthly", days: 30.4, count: 12 },
  { rhythm: "quarterly", days: 91.3, count: 4 },
  { rhythm: "halfyearly", days: 182.6, count: 2 },
  { rhythm: "yearly", days: 365.25, count: 1 },
];

/** Rhythm and current cost from bookings (amounts negative or positive, dates YYYY-MM-DD…). */
export function summarizeBookings(bookings: Array<{ date: string; amount: number }>): BookingSummary | null {
  if (bookings.length === 0) return null;
  const sorted = [...bookings].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  const lastAmount = Math.round(Math.abs(last.amount) * 100) / 100;
  let rhythm: Rhythm = "irregular";
  let perYearCount = 1;
  if (sorted.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((Date.parse(sorted[i].date.slice(0, 10)) - Date.parse(sorted[i - 1].date.slice(0, 10))) / 86_400_000);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    const match = RHYTHMS.find((r) => Math.abs(median - r.days) <= r.days * 0.25);
    if (match) {
      rhythm = match.rhythm;
      perYearCount = match.count;
    }
  }
  return {
    rhythm,
    perYearCount,
    lastAmount,
    lastDate: last.date.slice(0, 10),
    perYear: Math.round(lastAmount * perYearCount * 100) / 100,
    count: sorted.length,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function differs(current: number | null, proposed: number): boolean {
  if (current == null) return true;
  return Math.abs(current - proposed) > Math.max(1, Math.abs(current) * 0.005);
}

/**
 * The premium the bookings say, in the item's own terms, when it differs.
 * An irregular series says nothing about a rhythm and proposes nothing.
 */
export function bookingProposal(type: ItemType, data: Data, s: BookingSummary | null): Proposal | null {
  if (!s || s.rhythm === "irregular") return null;
  const monthly = s.perYear / 12;
  const make = (field: string, label: string, proposed: number): Proposal | null => {
    const current = num(data, field);
    return differs(current, proposed) ? { field, label, kind: "amount", current, proposed: round2(proposed) } : null;
  };
  switch (type) {
    case "expense":
      if (data.frequency === "yearly") return make("amount", "Beitrag pro Jahr", s.perYear);
      if (data.frequency === "monthly" || data.frequency == null) return make("amount", "Beitrag pro Monat", monthly);
      return null;
    case "life_insurance":
      return make("monthlyPremium", "Beitrag pro Monat", monthly);
    case "pension":
      return make("monthlyContribution", "Eigener Beitrag pro Monat", monthly);
    case "health_insurance":
      return make("employedAmount", "Beitrag pro Monat", monthly);
    default:
      return null;
  }
}

export const RHYTHM_LABELS: Record<Rhythm, string> = {
  monthly: "monatlich",
  quarterly: "vierteljährlich",
  halfyearly: "halbjährlich",
  yearly: "jährlich",
  irregular: "unregelmäßig",
};
