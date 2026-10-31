/**
 * The skeleton of the demo household (documentation/plans/demodaten.md):
 * which accounts it has and which bookings happen on them, decided by the
 * code from a seed. No database here — the plan is a list the writer lays
 * down, so the same seed and day give the same household, and a test can
 * check the plan without a database.
 *
 * Stage 1 fills the texts from templates. The LLM texts of stage 2 replace
 * purpose and counterparty wording, never dates or amounts.
 */

import { createRandom, type Random } from "./random";
import { DEMO_COUNTERPARTIES as CP, demoIban } from "./names";

export type DemoSize = "full" | "small";

/** The accounts of the household; `owner` says whose giro it is or that it is shared. */
export type AccountKey = "giro_self" | "giro_spouse" | "joint" | "savings";

export interface PlannedAccount {
  key: AccountKey;
  kind: "giro" | "tagesgeld";
  label: string;
  accountNumber: string;
  iban: string;
  /** Who holds it: the admin, the spouse, or both with write access. */
  owner: "self" | "spouse" | "both";
  /** Balance before the first planned booking, in cents. */
  openingCents: number;
}

export interface PlannedBooking {
  account: AccountKey;
  /** YYYY-MM-DD. */
  date: string;
  /** Signed, in cents. */
  cents: number;
  counterparty: string;
  counterpartyIban: string | null;
  purpose: string;
  entryText: string;
  /** What the booking is, for the summary and later stages (document matching). */
  kind: BookingKind;
}

export type BookingKind =
  | "salary"
  | "transfer"
  | "rent"
  | "electricity"
  | "gas"
  | "utility_settlement"
  | "child_benefit"
  | "phone"
  | "insurance"
  | "savings"
  | "interest"
  | "groceries"
  | "pharmacy"
  | "fuel"
  | "online";

export interface HouseholdPlan {
  accounts: PlannedAccount[];
  bookings: PlannedBooking[];
  /** First and last day the bookings cover. */
  from: string;
  to: string;
}

const SIZES: Record<DemoSize, { months: number; bookings: number }> = {
  full: { months: 36, bookings: 500 },
  small: { months: 3, bookings: 40 },
};

const MONTHS_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function iso(year: number, month: number, day: number): string {
  // month is 0-based; clamp the day to the month's length.
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const d = Math.min(day, last);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function counterpartyIban(name: string): string {
  // A stable made-up account number per counterparty, so the same payee
  // always books from the same IBAN — what recurring-payment detection
  // looks at.
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return demoIban(String(9_000_000_000 + (h % 999_999_999)));
}

/**
 * Plans the household for `size`, ending on `today` (YYYY-MM-DD). The fixed
 * bookings (salaries, rent, advance payments …) come first; the variable ones
 * (groceries, fuel, pharmacy, online) fill up to the size's booking count.
 */
export function planHousehold(seed: number, size: DemoSize, today: string): HouseholdPlan {
  const rnd = createRandom(seed);
  const { months, bookings: target } = SIZES[size];
  const [ty, tm] = today.split("-").map(Number);
  const startMonth = new Date(Date.UTC(ty, tm - 1 - (months - 1), 1));
  const from = iso(startMonth.getUTCFullYear(), startMonth.getUTCMonth(), 1);

  const accounts: PlannedAccount[] = [
    { key: "giro_self", kind: "giro", label: "Girokonto Demo-Bank", accountNumber: "0000100001", iban: demoIban("0000100001"), owner: "self", openingCents: 250_000 },
    { key: "giro_spouse", kind: "giro", label: "Girokonto Erika (Demo-Bank)", accountNumber: "0000100002", iban: demoIban("0000100002"), owner: "spouse", openingCents: 180_000 },
    { key: "joint", kind: "giro", label: "Gemeinschaftskonto Demo-Bank", accountNumber: "0000100003", iban: demoIban("0000100003"), owner: "both", openingCents: 300_000 },
    { key: "savings", kind: "tagesgeld", label: "Tagesgeld Demo-Bank", accountNumber: "0000100004", iban: demoIban("0000100004"), owner: "self", openingCents: 800_000 },
  ];
  const ibanOf = (key: AccountKey) => accounts.find((a) => a.key === key)!.iban;

  const fixed: PlannedBooking[] = [];
  const add = (b: Omit<PlannedBooking, "counterpartyIban"> & { counterpartyIban?: string | null }) => {
    if (b.date > today || b.date < from) return;
    fixed.push({ ...b, counterpartyIban: b.counterpartyIban === undefined ? counterpartyIban(b.counterparty) : b.counterpartyIban });
  };

  // Amounts that hold for a year and change at the turn of it.
  const salarySelf = new Map<number, number>();
  const salarySpouse = new Map<number, number>();
  const electricity = new Map<number, number>();
  const gas = new Map<number, number>();
  for (let y = startMonth.getUTCFullYear(); y <= ty; y++) {
    const step = y - startMonth.getUTCFullYear();
    salarySelf.set(y, Math.round(312_000 * 1.025 ** step) + rnd.int(0, 40) * 100);
    salarySpouse.set(y, Math.round(208_000 * 1.025 ** step) + rnd.int(0, 30) * 100);
    electricity.set(y, rnd.int(7, 10) * 1_000 + 500);
    gas.set(y, rnd.int(8, 12) * 1_000);
  }

  for (let i = 0; i < months; i++) {
    const at = new Date(Date.UTC(startMonth.getUTCFullYear(), startMonth.getUTCMonth() + i, 1));
    const y = at.getUTCFullYear();
    const m = at.getUTCMonth();
    const label = `${MONTHS_DE[m]} ${y}`;
    const mm = `${String(m + 1).padStart(2, "0")}/${y}`;

    add({ account: "giro_self", date: iso(y, m, 28), cents: salarySelf.get(y)!, counterparty: CP.employerSelf, purpose: `Lohn/Gehalt ${label}`, entryText: "Gutschrift", kind: "salary" });
    add({ account: "giro_spouse", date: iso(y, m, 30), cents: salarySpouse.get(y)!, counterparty: CP.employerSpouse, purpose: `Gehalt ${label}`, entryText: "Gutschrift", kind: "salary" });
    add({ account: "giro_self", date: iso(y, m, 1), cents: -180_000, counterparty: "Gemeinschaftskonto", counterpartyIban: ibanOf("joint"), purpose: `Haushaltsgeld ${mm}`, entryText: "Dauerauftrag", kind: "transfer" });
    add({ account: "joint", date: iso(y, m, 1), cents: 180_000, counterparty: "Max Mustermann", counterpartyIban: ibanOf("giro_self"), purpose: `Haushaltsgeld ${mm}`, entryText: "Gutschrift", kind: "transfer" });
    add({ account: "giro_spouse", date: iso(y, m, 2), cents: -110_000, counterparty: "Gemeinschaftskonto", counterpartyIban: ibanOf("joint"), purpose: `Haushaltsgeld ${mm}`, entryText: "Dauerauftrag", kind: "transfer" });
    add({ account: "joint", date: iso(y, m, 2), cents: 110_000, counterparty: "Erika Mustermann", counterpartyIban: ibanOf("giro_spouse"), purpose: `Haushaltsgeld ${mm}`, entryText: "Gutschrift", kind: "transfer" });
    add({ account: "joint", date: iso(y, m, 3), cents: -115_000, counterparty: CP.landlord, purpose: `Miete ${mm} Beispielstraße 1`, entryText: "Dauerauftrag", kind: "rent" });
    add({ account: "joint", date: iso(y, m, 15), cents: -electricity.get(y)!, counterparty: CP.utilities, purpose: `Abschlag Strom ${mm} Vertrag 000123`, entryText: "Lastschrift", kind: "electricity" });
    add({ account: "joint", date: iso(y, m, 15), cents: -gas.get(y)!, counterparty: CP.utilities, purpose: `Abschlag Gas ${mm} Vertrag 000124`, entryText: "Lastschrift", kind: "gas" });
    add({ account: "joint", date: iso(y, m, 10), cents: 25_500, counterparty: CP.familyFund, counterpartyIban: null, purpose: `Kindergeld ${mm} KG-Nr. 000FK000000`, entryText: "Gutschrift", kind: "child_benefit" });
    add({ account: "giro_self", date: iso(y, m, 20), cents: -2_999, counterparty: CP.phone, purpose: `Mobilfunk Rechnung ${mm}`, entryText: "Lastschrift", kind: "phone" });

    if (m % 3 === 0) {
      add({ account: "giro_self", date: iso(y, m, 5), cents: -60_000, counterparty: "Tagesgeld Demo-Bank", counterpartyIban: ibanOf("savings"), purpose: "Sparen", entryText: "Überweisung", kind: "savings" });
      add({ account: "savings", date: iso(y, m, 5), cents: 60_000, counterparty: "Max Mustermann", counterpartyIban: ibanOf("giro_self"), purpose: "Sparen", entryText: "Gutschrift", kind: "savings" });
    }
    if (m % 3 === 2) {
      add({ account: "savings", date: iso(y, m, 31), cents: rnd.int(1_500, 4_500), counterparty: "Demo-Bank eG", counterpartyIban: null, purpose: `Zinsen ${Math.floor(m / 3) + 1}. Quartal ${y}`, entryText: "Zinsgutschrift", kind: "interest" });
    }
    if (m === 0) {
      add({ account: "joint", date: iso(y, m, 12), cents: -rnd.int(380, 460) * 100, counterparty: CP.insurer, purpose: `Beitrag Hausrat- und Haftpflichtversicherung ${y}`, entryText: "Lastschrift", kind: "insurance" });
    }
    if (m === 2) {
      // The annual utility bill: a refund or an additional payment.
      const sign = rnd.chance(0.5) ? 1 : -1;
      add({ account: "joint", date: iso(y, m, 18), cents: sign * rnd.int(40, 260) * 100, counterparty: CP.utilities, purpose: `Jahresabrechnung Strom und Gas ${y - 1}`, entryText: sign > 0 ? "Gutschrift" : "Lastschrift", kind: "utility_settlement" });
    }
  }

  const variable: PlannedBooking[] = [];
  const firstDay = Date.UTC(startMonth.getUTCFullYear(), startMonth.getUTCMonth(), 1);
  const lastDay = Date.UTC(ty, tm - 1, Number(today.slice(8, 10)));
  const days = Math.floor((lastDay - firstDay) / 86_400_000);
  for (let n = fixed.length; n < target; n++) {
    variable.push(variableBooking(rnd, new Date(firstDay + rnd.int(0, days) * 86_400_000)));
  }

  const bookings = [...fixed, ...variable].sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));
  return { accounts, bookings, from, to: today };
}

function variableBooking(rnd: Random, at: Date): PlannedBooking {
  const date = iso(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const roll = rnd.next();
  if (roll < 0.6) {
    const shop = rnd.pick(CP.groceries);
    return { account: "joint", date, cents: -rnd.cents(8, 140), counterparty: shop, counterpartyIban: null, purpose: `Kartenzahlung ${shop}`, entryText: "Kartenzahlung", kind: "groceries" };
  }
  if (roll < 0.75) {
    return { account: "giro_self", date, cents: -rnd.cents(45, 95), counterparty: CP.fuel, counterpartyIban: null, purpose: "Kartenzahlung Tankstelle", entryText: "Kartenzahlung", kind: "fuel" };
  }
  if (roll < 0.85) {
    return { account: "giro_spouse", date, cents: -rnd.cents(5, 60), counterparty: CP.pharmacy, counterpartyIban: null, purpose: "Kartenzahlung Apotheke", entryText: "Kartenzahlung", kind: "pharmacy" };
  }
  const order = String(rnd.int(100_000, 999_999));
  return { account: rnd.chance(0.5) ? "giro_self" : "giro_spouse", date, cents: -rnd.cents(12, 180), counterparty: CP.online, counterpartyIban: counterpartyIban(CP.online), purpose: `Bestellung BV-${order}`, entryText: "Lastschrift", kind: "online" };
}
