// Retirement forecast — the simulation (issue #1337).
//
// A pure function: persons, milestones, items and a scenario go in, a
// yearly series comes out. No database, no Encore runtime, so the whole
// thing is unit-testable and cheap enough to run on every slider move.
//
// The model, in one paragraph: a household has persons; a person has
// milestones (leaving work, pension start, …); items (salary, pensions,
// insurances, assets, expenses) start and end at milestones or dates.
// The simulation walks month by month from the start date to the end
// age, adds income, subtracts expenses, lets pots grow, and when a month
// ends in deficit it withdraws from the pots in the configured order.
// The result is aggregated per calendar year for the charts, plus the
// bridge phases and the verdict "does the money last?".
//
// Everything is nominal. The frontend deflates with the inflation
// assumption when the user asks for today's purchasing power.

// -----------------------------------------------------------------------
// Input types
// -----------------------------------------------------------------------

export type Frequency = "monthly" | "yearly" | "once";

export interface ForecastPerson {
  id: number;
  label: string;
  /** YYYY-MM-DD */
  birthDate: string;
}

export type MilestoneKind =
  | "leave_work"
  | "statutory_pension"
  | "company_pension"
  | "private_pension"
  | "life_insurance_maturity"
  | "custom";

export interface ForecastMilestone {
  id: number;
  personId: number;
  kind: MilestoneKind;
  label: string;
  /** Exactly one of date / age is set. */
  date?: string | null;
  age?: number | null;
}

/**
 * A point in time an item refers to. `milestone` is the normal case;
 * `date` and `age` exist for things that do not depend on a person's
 * decision (end of a loan) or for quick entry.
 */
export type TimeRef =
  | { kind: "milestone"; milestoneId: number }
  | { kind: "date"; date: string }
  | { kind: "age"; personId: number; age: number };

export type Pot = "cash" | "depot" | "real_estate" | "other" | "insurance";

export type HealthInsuranceMode =
  | "employed" // employer pays half; the amount is the employee's share
  | "statutory_voluntary" // rate × own income, at least the minimum
  | "family" // insured via the partner, nothing to pay
  | "kvdr" // pensioners' statutory insurance: rate × pensions only
  | "private"; // fixed premium with its own increase

export type PensionKind = "statutory" | "company" | "private";

interface ItemBase {
  id: number;
  label: string;
  /** null = household item (shared). */
  personId: number | null;
  /** null = from the start of the simulation. */
  start?: TimeRef | null;
  /** null = until the end of the horizon. */
  end?: TimeRef | null;
}

export interface SalaryItem extends ItemBase {
  type: "salary";
  personId: number;
  /** Net per month. */
  amount: number;
  /** Yearly raise, e.g. 0.02. */
  growthRate: number;
}

export interface IncomeItem extends ItemBase {
  type: "income";
  amount: number;
  frequency: Frequency;
  growthRate: number;
  /** Flat tax on this income, e.g. 0.25 for rent. */
  taxRate: number;
}

export interface ExpenseItem extends ItemBase {
  type: "expense";
  amount: number;
  frequency: Frequency;
  /** null = follows inflation. */
  growthRate: number | null;
}

/** Living expenses of the household — follow the spending curve. */
export interface LivingExpenseItem extends ItemBase {
  type: "living_expense";
  /** Per month, today's money. */
  amount: number;
}

export interface HealthInsuranceItem extends ItemBase {
  type: "health_insurance";
  personId: number;
  /** While earning (until leave_work). */
  employedAmount: number;
  /** Between leaving work and the statutory pension. */
  bridgeMode: HealthInsuranceMode;
  /** Used by the private mode only. */
  bridgeAmount: number;
  /** From the statutory pension on. */
  retiredMode: HealthInsuranceMode;
  retiredAmount: number;
  /** Yearly increase of a private premium, e.g. 0.03. */
  privateGrowthRate: number;
}

export interface AssetItem extends ItemBase {
  type: "asset";
  pot: Exclude<Pot, "insurance">;
  currentValue: number;
  /** Yearly return, e.g. 0.05. null = scenario default. */
  returnRate: number | null;
  /** Savings plan: moved from cash into this pot each month until `contributionEnd`. */
  monthlyContribution: number;
  contributionEnd?: TimeRef | null;
  /** Filled in by the API from the latest finance_account_balance. */
  linkedAccountId?: number | null;
}

export interface LifeInsuranceItem extends ItemBase {
  type: "life_insurance";
  personId: number;
  surrenderValue: number;
  monthlyPremium: number;
  premiumEnd?: TimeRef | null;
  guaranteedPayout: number;
  projectedPayout: number;
  /** Usually a life_insurance_maturity milestone. */
  maturity: TimeRef;
  payoutMode: "lump_sum" | "annuity";
  /** Monthly annuity if payoutMode is annuity. */
  annuityAmount: number;
  /** Flat tax on the payout / annuity. */
  taxRate: number;
}

export interface PensionItem extends ItemBase {
  type: "pension";
  personId: number;
  kind: PensionKind;
  /** Projected monthly pension at `regularAge` (statutory) or at `start`. */
  monthlyAmount: number;
  /** Usually a *_pension milestone. */
  start: TimeRef;
  /** Statutory: regular age the projection refers to. */
  regularAge: number | null;
  /** Statutory: deduction per month of early start, e.g. 0.003. */
  deductionPerMonth: number;
  /** One-off cost to buy back the deduction (§ 187a SGB VI), from the pension statement. */
  deductionOffsetCost: number | null;
  /** Yearly pension adjustment, e.g. 0.02. */
  growthRate: number;
  /** Own contribution per month until `contributionEnd` (company / private). */
  monthlyContribution: number;
  contributionEnd?: TimeRef | null;
  /** Lump sum instead of the annuity, if the contract offers it. */
  lumpSumOption: number | null;
  payoutMode: "annuity" | "lump_sum";
  taxRate: number;
}

export type ForecastItem =
  | SalaryItem
  | IncomeItem
  | ExpenseItem
  | LivingExpenseItem
  | HealthInsuranceItem
  | AssetItem
  | LifeInsuranceItem
  | PensionItem;

// Spelled out rather than `ForecastItem["type"]`: Encore's parser does not
// resolve an indexed access on a union, and this name reaches the API.
export type ItemType =
  | "salary"
  | "income"
  | "expense"
  | "living_expense"
  | "health_insurance"
  | "asset"
  | "life_insurance"
  | "pension";

export interface SpendingPhase {
  /** Age of the reference person from which this factor applies. */
  fromAge: number;
  /** Multiplier on living expenses, 1 = unchanged. */
  factor: number;
}

export interface ForecastScenario {
  id?: number;
  name: string;
  inflationRate: number;
  defaultReturnRate: number;
  /** Flat tax on capital returns and on the gain share of depot sales. */
  capitalGainsTaxRate: number;
  /** Share of a depot sale that counts as gain. */
  depotGainShare: number;
  /** Liquid wealth must never drop below this. */
  minLiquidWealth: number;
  /** Horizon: age of the youngest person. */
  endAge: number;
  /** Overrides for milestones — this is what a scenario changes. */
  milestoneOverrides: Record<string, { date?: string | null; age?: number | null }>;
  withdrawalOrder: Array<Exclude<Pot, "insurance">>;
  /** May an insurance be surrendered early when the liquid pots are empty? */
  allowSurrender: boolean;
  spendingCurve: {
    referencePersonId: number | null;
    phases: SpendingPhase[];
    /** Extra care cost per person per month (today's money) from `careFromAge`. */
    careFromAge: number | null;
    careMonthly: number;
  };
  healthInsurance: {
    /** Contribution rate incl. additional contribution and care, e.g. 0.20. */
    rate: number;
    /** Minimum monthly contribution for the voluntarily insured. */
    minMonthly: number;
  };
  /** Person ids for which the deduction buy-back is applied. */
  offsetDeductions: number[];
}

export interface ForecastInput {
  persons: ForecastPerson[];
  milestones: ForecastMilestone[];
  items: ForecastItem[];
  scenario: ForecastScenario;
  /** First day of the first simulated month, YYYY-MM-DD. Defaults to today. */
  startDate?: string;
}

// -----------------------------------------------------------------------
// Output types
// -----------------------------------------------------------------------

export interface FlowSource {
  key: string;
  label: string;
  personId: number | null;
  kind: ItemType | "care" | "tax" | "surrender";
}

export interface YearRow {
  year: number;
  /** Age of each person at the end of the year. */
  ages: Record<string, number>;
  income: Record<string, number>;
  expenses: Record<string, number>;
  /** Premiums and contributions that flow into pots (not lost, but not available). */
  contributions: number;
  returns: number;
  taxes: number;
  withdrawals: Record<string, number>;
  /** Pot values at year end. */
  pots: Record<string, number>;
  wealthEnd: number;
  liquidEnd: number;
  totalIncome: number;
  totalExpenses: number;
  /** Regular income (without returns) did not cover expenses in some month. */
  deficit: boolean;
}

export interface BridgePhase {
  personId: number | null;
  fromYear: number;
  toYear: number;
  /** Sum of monthly deficits (nominal). */
  need: number;
  /** Liquid wealth when the phase starts. */
  liquidAtStart: number;
  covered: boolean;
}

export interface ResolvedMilestone {
  id: number;
  personId: number;
  kind: MilestoneKind;
  label: string;
  date: string;
  year: number;
  age: number;
}

export interface SimulationResult {
  startYear: number;
  endYear: number;
  years: YearRow[];
  sources: FlowSource[];
  pots: Pot[];
  milestones: ResolvedMilestone[];
  bridges: BridgePhase[];
  /** Liquid wealth stayed above the minimum until the end. */
  ok: boolean;
  /** First year the minimum was breached. */
  failYear: number | null;
  /** First year a pot reached zero (only pots that had something). */
  potDryYear: Record<string, number | null>;
  /** Wealth at the end of the horizon (nominal). */
  finalWealth: number;
}

export interface MatrixCell {
  ageA: number;
  ageB: number;
  ok: boolean;
  finalWealth: number;
  failYear: number | null;
}

// -----------------------------------------------------------------------
// Time helpers — months since 0000-01 as the internal clock
// -----------------------------------------------------------------------

function parseYm(date: string): { y: number; m: number } {
  const [y, m] = date.split("-").map(Number);
  return { y, m: m ?? 1 };
}

function monthIndex(date: string): number {
  const { y, m } = parseYm(date);
  return y * 12 + (m - 1);
}

function yearOf(mi: number): number {
  return Math.floor(mi / 12);
}

function ymString(mi: number): string {
  const y = yearOf(mi);
  const m = mi - y * 12 + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** Age in completed years at month index `mi`. */
function ageAt(birth: string, mi: number): number {
  const b = monthIndex(birth);
  return Math.floor((mi - b) / 12);
}

function monthlyRate(yearly: number): number {
  return Math.pow(1 + yearly, 1 / 12) - 1;
}

function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// -----------------------------------------------------------------------
// Resolving milestones and time refs
// -----------------------------------------------------------------------

type Resolved = Map<number, number>; // milestoneId → month index

class Context {
  readonly persons = new Map<number, ForecastPerson>();
  readonly milestoneByPerson = new Map<string, number>(); // `${personId}:${kind}` → month
  constructor(
    readonly input: ForecastInput,
    readonly milestones: Resolved,
  ) {
    for (const p of input.persons) this.persons.set(p.id, p);
    for (const m of input.milestones) {
      const mi = milestones.get(m.id);
      if (mi === undefined) continue;
      const key = `${m.personId}:${m.kind}`;
      // First milestone of a kind wins for the health-insurance switches.
      if (!this.milestoneByPerson.has(key)) this.milestoneByPerson.set(key, mi);
    }
  }

  resolve(ref: TimeRef | null | undefined, fallback: number): number {
    if (!ref) return fallback;
    switch (ref.kind) {
      case "milestone": {
        const mi = this.milestones.get(ref.milestoneId);
        return mi === undefined ? fallback : mi;
      }
      case "date":
        return monthIndex(ref.date);
      case "age": {
        const p = this.persons.get(ref.personId);
        return p ? monthIndex(p.birthDate) + ref.age * 12 : fallback;
      }
    }
  }

  personMilestone(personId: number, kind: MilestoneKind): number | null {
    return this.milestoneByPerson.get(`${personId}:${kind}`) ?? null;
  }
}

function resolveMilestones(input: ForecastInput): Resolved {
  const persons = new Map(input.persons.map((p) => [p.id, p]));
  const out: Resolved = new Map();
  for (const m of input.milestones) {
    const override = input.scenario.milestoneOverrides[String(m.id)];
    const date = override?.date !== undefined ? override.date : m.date;
    const age = override?.age !== undefined ? override.age : m.age;
    const p = persons.get(m.personId);
    if (override?.age != null && p) {
      out.set(m.id, monthIndex(p.birthDate) + override.age * 12);
    } else if (override?.date) {
      out.set(m.id, monthIndex(override.date));
    } else if (date) {
      out.set(m.id, monthIndex(date));
    } else if (age != null && p) {
      out.set(m.id, monthIndex(p.birthDate) + age * 12);
    }
  }
  return out;
}

// -----------------------------------------------------------------------
// The simulation
// -----------------------------------------------------------------------

const POTS: Pot[] = ["cash", "depot", "real_estate", "other", "insurance"];
const LIQUID: ReadonlySet<Pot> = new Set<Pot>(["cash", "depot", "other"]);

interface PotState {
  value: number;
  /** Yearly return of the pot — weighted by the assets that make it up. */
  returnRate: number;
}

interface InsuranceState {
  item: LifeInsuranceItem;
  value: number;
  maturity: number;
  premiumEnd: number;
  surrendered: boolean;
  paidOut: boolean;
}

function frequencyToMonthly(amount: number, freq: Frequency, mi: number, start: number): number {
  switch (freq) {
    case "monthly":
      return amount;
    case "yearly":
      // Paid once a year, in the month the item started.
      return (mi - start) % 12 === 0 ? amount : 0;
    case "once":
      return mi === start ? amount : 0;
  }
}

function add(rec: Record<string, number>, key: string, v: number): void {
  if (v === 0) return;
  rec[key] = (rec[key] ?? 0) + v;
}

export function simulate(input: ForecastInput): SimulationResult {
  const { persons, items, scenario } = input;
  const startDate = input.startDate ?? isoToday();
  const start = monthIndex(startDate);
  const startYear = yearOf(start);

  const resolved = resolveMilestones(input);
  const ctx = new Context(input, resolved);

  // Horizon: the youngest person reaches endAge.
  const youngestBirth = persons.length
    ? Math.max(...persons.map((p) => monthIndex(p.birthDate)))
    : start;
  const endExclusive = Math.max(start + 12, youngestBirth + scenario.endAge * 12 + 12);
  const endMonth = endExclusive - (endExclusive % 12); // full years only
  const endYear = yearOf(endMonth) - 1;

  // --- pots -----------------------------------------------------------
  const pots = new Map<Pot, PotState>();
  for (const p of POTS) pots.set(p, { value: 0, returnRate: p === "cash" ? 0 : scenario.defaultReturnRate });
  {
    const weights = new Map<Pot, { sum: number; weighted: number }>();
    for (const it of items) {
      if (it.type !== "asset") continue;
      const r = it.returnRate ?? scenario.defaultReturnRate;
      const w = weights.get(it.pot) ?? { sum: 0, weighted: 0 };
      w.sum += it.currentValue;
      w.weighted += it.currentValue * r;
      weights.set(it.pot, w);
    }
    for (const [pot, w] of weights) {
      const s = pots.get(pot)!;
      s.value = w.sum;
      s.returnRate = w.sum > 0 ? w.weighted / w.sum : scenario.defaultReturnRate;
    }
    // Return rates of assets without value still matter once contributions arrive.
    for (const it of items) {
      if (it.type !== "asset" || it.currentValue > 0 || it.returnRate == null) continue;
      const s = pots.get(it.pot)!;
      if ((weights.get(it.pot)?.sum ?? 0) === 0) s.returnRate = it.returnRate;
    }
  }

  const insurances: InsuranceState[] = items
    .filter((it): it is LifeInsuranceItem => it.type === "life_insurance")
    .map((it) => ({
      item: it,
      value: it.surrenderValue,
      maturity: ctx.resolve(it.maturity, endMonth),
      premiumEnd: ctx.resolve(it.premiumEnd, ctx.resolve(it.maturity, endMonth)),
      surrendered: false,
      paidOut: false,
    }));
  pots.get("insurance")!.value = insurances.reduce((s, i) => s + i.value, 0);

  // --- sources for the cash-flow chart -----------------------------------
  const sources: FlowSource[] = [];
  const sourceKeys = new Set<string>();
  const source = (key: string, label: string, personId: number | null, kind: FlowSource["kind"]) => {
    if (sourceKeys.has(key)) return key;
    sourceKeys.add(key);
    sources.push({ key, label, personId, kind });
    return key;
  };

  // --- pre-resolve item windows ------------------------------------------
  interface Window {
    item: ForecastItem;
    from: number;
    to: number; // exclusive
  }
  const windows: Window[] = items.map((it) => {
    let from = ctx.resolve(it.start, start);
    let to = ctx.resolve(it.end, endMonth);
    if (it.type === "salary" && !it.end) {
      // Salary ends when the person leaves work, unless the item says otherwise.
      to = ctx.personMilestone(it.personId, "leave_work") ?? endMonth;
    }
    if (it.type === "pension") from = ctx.resolve(it.start, endMonth);
    return { item: it, from, to };
  });

  // Statutory pension after deductions, and the buy-back cost.
  const pensionAmount = new Map<number, number>();
  const buyBack = new Map<number, number>(); // month → cost
  for (const w of windows) {
    const it = w.item;
    if (it.type !== "pension") continue;
    let amount = it.monthlyAmount;
    if (it.kind === "statutory" && it.regularAge != null) {
      const p = ctx.persons.get(it.personId);
      if (p) {
        const regular = monthIndex(p.birthDate) + it.regularAge * 12;
        const early = Math.max(0, regular - w.from);
        const offset = scenario.offsetDeductions.includes(it.personId) && it.deductionOffsetCost != null;
        if (early > 0 && !offset) amount = amount * (1 - early * it.deductionPerMonth);
        if (early > 0 && offset) {
          // Paid at the start of the simulation — the statement quotes today's price.
          buyBack.set(it.id, it.deductionOffsetCost!);
        }
      }
    }
    pensionAmount.set(it.id, amount);
  }

  // --- yearly accumulators ------------------------------------------------
  const years: YearRow[] = [];
  const potDryYear: Record<string, number | null> = {};
  for (const p of POTS) potDryYear[p] = null;
  const potHadValue = new Set<Pot>();
  for (const [pot, s] of pots) if (pot !== "insurance" && s.value > 1) potHadValue.add(pot);
  let failYear: number | null = null;
  let taxesYear = 0;

  // Bridge tracking: monthly household deficit flags.
  const monthlyDeficit: boolean[] = [];
  const monthlyDeficitAmount: number[] = [];
  const monthlyLiquid: number[] = [];

  const refPersonId = scenario.spendingCurve.referencePersonId ?? persons[0]?.id ?? null;
  const refPerson = refPersonId != null ? ctx.persons.get(refPersonId) : undefined;
  const phases = [...scenario.spendingCurve.phases].sort((a, b) => a.fromAge - b.fromAge);

  const inflationIndex = (mi: number) =>
    Math.pow(1 + scenario.inflationRate, (mi - start) / 12);
  const growthIndex = (rate: number, mi: number, from: number) =>
    Math.pow(1 + rate, Math.floor((mi - from) / 12)); // raised once a year

  let row: YearRow | null = null;
  const newRow = (year: number): YearRow => ({
    year,
    ages: {},
    income: {},
    expenses: {},
    contributions: 0,
    returns: 0,
    taxes: 0,
    withdrawals: {},
    pots: {},
    wealthEnd: 0,
    liquidEnd: 0,
    totalIncome: 0,
    totalExpenses: 0,
    deficit: false,
  });

  const liquidWealth = () => {
    let s = 0;
    for (const p of LIQUID) s += pots.get(p)!.value;
    return s;
  };

  /** Withdraw `need` from the liquid pots in order; returns what could not be covered. */
  const withdraw = (need: number, mi: number, r: YearRow): number => {
    let remaining = need;
    for (const pot of scenario.withdrawalOrder) {
      if (remaining <= 0) break;
      const s = pots.get(pot)!;
      if (s.value <= 0) continue;
      // Selling depot: part of the proceeds is gain and taxed, so sell gross.
      const taxShare = pot === "depot" ? scenario.depotGainShare * scenario.capitalGainsTaxRate : 0;
      const grossNeeded = remaining / (1 - taxShare);
      const gross = Math.min(grossNeeded, s.value);
      const tax = gross * taxShare;
      s.value -= gross;
      taxesYear += tax;
      add(r.withdrawals, pot, gross);
      remaining -= gross - tax;
    }
    if (remaining > 0 && scenario.allowSurrender) {
      for (const ins of insurances) {
        if (remaining <= 0) break;
        if (ins.surrendered || ins.paidOut || ins.value <= 0 || mi >= ins.maturity) continue;
        const net = ins.value * (1 - ins.item.taxRate);
        ins.surrendered = true;
        add(r.withdrawals, "insurance", ins.value);
        add(r.income, source(`surrender:${ins.item.id}`, `${ins.item.label} (Rückkauf)`, ins.item.personId, "surrender"), net);
        taxesYear += ins.value - net;
        ins.value = 0;
        remaining -= net;
      }
      // A surrender pays out the whole contract; what the month did not need stays in cash.
      if (remaining < 0) {
        pots.get("cash")!.value += -remaining;
        remaining = 0;
      }
    }
    return Math.max(0, remaining);
  };

  for (let mi = start; mi < endMonth; mi++) {
    const year = yearOf(mi);
    if (!row || row.year !== year) {
      row = newRow(year);
      years.push(row);
      taxesYear = 0;
    }
    const r = row;
    const infl = inflationIndex(mi);

    let income = 0; // regular income this month (net)
    let expenses = 0; // everything that leaves the household
    let toPots = 0; // premiums and contributions (leave cash, land in a pot)

    // Per-person income this month for rate-based health insurance.
    const personIncome = new Map<number, number>();
    const personPension = new Map<number, number>();
    const addPersonal = (pid: number | null, v: number, pension: boolean) => {
      if (pid == null) return;
      personIncome.set(pid, (personIncome.get(pid) ?? 0) + v);
      if (pension) personPension.set(pid, (personPension.get(pid) ?? 0) + v);
    };

    // Buy-back of deductions in the first month.
    if (mi === start) {
      for (const [itemId, cost] of buyBack) {
        const it = items.find((i) => i.id === itemId)!;
        const key = source(`buyback:${itemId}`, `${it.label} (Ausgleich Abschlag)`, it.personId, "pension");
        add(r.expenses, key, cost);
        expenses += cost;
      }
    }

    // ---- pass 1: income and plain expenses ------------------------------
    for (const w of windows) {
      const it = w.item;
      const active = mi >= w.from && mi < w.to;
      switch (it.type) {
        case "salary": {
          if (!active) break;
          const v = it.amount * growthIndex(it.growthRate, mi, w.from);
          add(r.income, source(`item:${it.id}`, it.label, it.personId, it.type), v);
          income += v;
          addPersonal(it.personId, v, false);
          break;
        }
        case "income": {
          if (!active) break;
          const gross = frequencyToMonthly(it.amount, it.frequency, mi, w.from) * growthIndex(it.growthRate, mi, w.from);
          if (gross === 0) break;
          const v = gross * (1 - it.taxRate);
          taxesYear += gross - v;
          add(r.income, source(`item:${it.id}`, it.label, it.personId, it.type), v);
          income += v;
          addPersonal(it.personId, v, false);
          break;
        }
        case "expense": {
          if (!active) break;
          const idx = it.growthRate == null ? infl : growthIndex(it.growthRate, mi, w.from);
          const v = frequencyToMonthly(it.amount, it.frequency, mi, w.from) * idx;
          if (v === 0) break;
          add(r.expenses, source(`item:${it.id}`, it.label, it.personId, it.type), v);
          expenses += v;
          break;
        }
        case "living_expense": {
          if (!active) break;
          let factor = 1;
          if (refPerson) {
            const age = ageAt(refPerson.birthDate, mi);
            for (const ph of phases) if (age >= ph.fromAge) factor = ph.factor;
          }
          const v = it.amount * factor * infl;
          add(r.expenses, source(`item:${it.id}`, it.label, null, it.type), v);
          expenses += v;
          break;
        }
        case "pension": {
          const base = pensionAmount.get(it.id) ?? it.monthlyAmount;
          // Contributions before the start.
          const contribEnd = ctx.resolve(it.contributionEnd, w.from);
          if (it.monthlyContribution > 0 && mi >= start && mi < Math.min(contribEnd, w.from)) {
            add(r.expenses, source(`contrib:${it.id}`, `${it.label} (Beitrag)`, it.personId, it.type), it.monthlyContribution);
            expenses += it.monthlyContribution;
            r.contributions += it.monthlyContribution;
          }
          if (it.payoutMode === "lump_sum" && it.lumpSumOption != null) {
            if (mi === w.from) {
              const v = it.lumpSumOption * (1 - it.taxRate);
              taxesYear += it.lumpSumOption - v;
              add(r.income, source(`item:${it.id}`, it.label, it.personId, it.type), v);
              income += v;
              addPersonal(it.personId, v, true);
            }
            break;
          }
          if (!active) break;
          const gross = base * growthIndex(it.growthRate, mi, w.from);
          const v = gross * (1 - it.taxRate);
          taxesYear += gross - v;
          add(r.income, source(`item:${it.id}`, it.label, it.personId, it.type), v);
          income += v;
          addPersonal(it.personId, v, true);
          break;
        }
        case "asset":
        case "life_insurance":
        case "health_insurance":
          break; // handled below
      }
    }

    // ---- care costs -----------------------------------------------------
    const care = scenario.spendingCurve;
    if (care.careFromAge != null && care.careMonthly > 0) {
      for (const p of persons) {
        if (ageAt(p.birthDate, mi) >= care.careFromAge) {
          const v = care.careMonthly * infl;
          add(r.expenses, source(`care:${p.id}`, `Pflege ${p.label}`, p.id, "care"), v);
          expenses += v;
        }
      }
    }

    // ---- life insurances: premiums, maturity, annuities -----------------
    for (const ins of insurances) {
      const it = ins.item;
      if (ins.surrendered) continue;
      if (!ins.paidOut && mi < ins.maturity) {
        if (it.monthlyPremium > 0 && mi < ins.premiumEnd) {
          add(r.expenses, source(`contrib:${it.id}`, `${it.label} (Beitrag)`, it.personId, it.type), it.monthlyPremium);
          expenses += it.monthlyPremium;
          toPots += it.monthlyPremium;
          r.contributions += it.monthlyPremium;
        }
        // Value grows linearly from today's surrender value to the projected payout.
        const total = Math.max(1, ins.maturity - start);
        const done = Math.min(total, mi + 1 - start);
        ins.value = it.surrenderValue + (it.projectedPayout - it.surrenderValue) * (done / total);
      }
      if (!ins.paidOut && mi >= ins.maturity) {
        ins.paidOut = true;
        ins.value = 0;
        if (it.payoutMode === "lump_sum") {
          const v = it.projectedPayout * (1 - it.taxRate);
          taxesYear += it.projectedPayout - v;
          add(r.income, source(`item:${it.id}`, it.label, it.personId, it.type), v);
          income += v;
          addPersonal(it.personId, v, true);
        }
      }
      if (ins.paidOut && it.payoutMode === "annuity" && mi >= ins.maturity) {
        const v = it.annuityAmount * (1 - it.taxRate);
        taxesYear += it.annuityAmount - v;
        add(r.income, source(`item:${it.id}`, it.label, it.personId, it.type), v);
        income += v;
        addPersonal(it.personId, v, true);
      }
    }
    pots.get("insurance")!.value = insurances.reduce((s, i) => s + i.value, 0);

    // ---- health insurance (needs the person's income of this month) ----
    for (const w of windows) {
      const it = w.item;
      if (it.type !== "health_insurance") continue;
      if (!(mi >= w.from && mi < w.to)) continue;
      const leave = ctx.personMilestone(it.personId, "leave_work");
      const pensionStart = ctx.personMilestone(it.personId, "statutory_pension");
      let mode: HealthInsuranceMode;
      let fixed: number;
      if (leave == null || mi < leave) {
        mode = "employed";
        fixed = it.employedAmount;
      } else if (pensionStart == null || mi < pensionStart) {
        mode = it.bridgeMode;
        fixed = it.bridgeAmount;
      } else {
        mode = it.retiredMode;
        fixed = it.retiredAmount;
      }
      let v = 0;
      switch (mode) {
        case "employed":
          v = fixed * infl;
          break;
        case "family":
          v = 0;
          break;
        case "private":
          v = fixed * growthIndex(it.privateGrowthRate, mi, start);
          break;
        case "statutory_voluntary":
          v = Math.max(scenario.healthInsurance.minMonthly * infl, (personIncome.get(it.personId) ?? 0) * scenario.healthInsurance.rate);
          break;
        case "kvdr":
          v = (personPension.get(it.personId) ?? 0) * scenario.healthInsurance.rate;
          break;
      }
      if (v > 0) {
        add(r.expenses, source(`item:${it.id}`, it.label, it.personId, it.type), v);
        expenses += v;
      }
    }

    // ---- returns on pots -------------------------------------------------
    for (const [pot, s] of pots) {
      if (pot === "insurance" || s.value <= 0) continue;
      const gross = s.value * monthlyRate(s.returnRate);
      const tax = pot === "cash" || pot === "real_estate" ? 0 : gross * scenario.capitalGainsTaxRate;
      s.value += gross - tax;
      r.returns += gross - tax;
      taxesYear += tax;
    }

    // ---- cash flow: surplus to cash, deficit from the pots ---------------
    const net = income - expenses;
    const cash = pots.get("cash")!;
    if (net >= 0) {
      cash.value += net;
    } else {
      const need = -net;
      const fromCash = Math.min(cash.value, need);
      cash.value -= fromCash;
      if (fromCash > 0) add(r.withdrawals, "cash", fromCash);
      const uncovered = withdraw(need - fromCash, mi, r);
      if (uncovered > 0) cash.value -= uncovered; // goes negative: the failure shows up below
    }
    if (net < 0) r.deficit = true;
    monthlyDeficit.push(net < 0);
    monthlyDeficitAmount.push(net < 0 ? -net : 0);

    // ---- savings plans: cash → pot ----------------------------------------
    for (const w of windows) {
      const it = w.item;
      if (it.type !== "asset" || it.monthlyContribution <= 0) continue;
      const until = ctx.resolve(it.contributionEnd, w.to);
      if (mi < w.from || mi >= until) continue;
      if (cash.value < it.monthlyContribution) continue; // nothing spare this month
      cash.value -= it.monthlyContribution;
      pots.get(it.pot)!.value += it.monthlyContribution;
      r.contributions += it.monthlyContribution;
    }

    // ---- bookkeeping -----------------------------------------------------
    const liquid = liquidWealth();
    monthlyLiquid.push(liquid);
    if (liquid < scenario.minLiquidWealth && failYear === null) failYear = year;
    r.totalIncome += income;
    r.totalExpenses += expenses;

    // Year end (or last month): freeze the state into the row.
    if (mi % 12 === 11 || mi === endMonth - 1) {
      for (const [pot, s] of pots) {
        r.pots[pot] = s.value;
        // "Dry" is judged at year end: cash dips to zero in a bad month
        // and refills next month, which is not a pot running out. The
        // insurance pot empties by design at maturity, so it is left out.
        if (pot === "insurance") continue;
        if (s.value > 1) potHadValue.add(pot);
        else if (potHadValue.has(pot) && potDryYear[pot] === null) potDryYear[pot] = year;
      }
      r.wealthEnd = [...pots.values()].reduce((a, s) => a + s.value, 0);
      r.liquidEnd = liquid;
      r.taxes = taxesYear;
      for (const p of persons) r.ages[String(p.id)] = ageAt(p.birthDate, mi);
    }
  }

  // --- bridge phases -------------------------------------------------------
  const bridges: BridgePhase[] = [];
  // Household: contiguous runs of deficit months.
  {
    let runStart = -1;
    let need = 0;
    for (let i = 0; i <= monthlyDeficit.length; i++) {
      const d = i < monthlyDeficit.length && monthlyDeficit[i];
      if (d && runStart < 0) {
        runStart = i;
        need = 0;
      }
      if (d) need += monthlyDeficitAmount[i];
      if (!d && runStart >= 0) {
        // Ignore runs shorter than 3 months — a yearly bill is not a bridge.
        if (i - runStart >= 3) {
          const liquidAtStart = runStart > 0 ? monthlyLiquid[runStart - 1] : liquidWealthAtStart(input, items);
          bridges.push({
            personId: null,
            fromYear: yearOf(start + runStart),
            toYear: yearOf(start + i - 1),
            need,
            liquidAtStart,
            covered: liquidAtStart - need >= scenario.minLiquidWealth,
          });
        }
        runStart = -1;
      }
    }
  }
  // Per person: leave_work → first pension start.
  for (const p of persons) {
    const leave = ctx.personMilestone(p.id, "leave_work");
    if (leave == null) continue;
    const pensionStarts = windows
      .filter((w) => w.item.type === "pension" && w.item.personId === p.id)
      .map((w) => w.from)
      .filter((m) => m > leave);
    if (pensionStarts.length === 0) continue;
    const firstPension = Math.min(...pensionStarts);
    if (firstPension <= leave) continue;
    const fromIdx = Math.max(0, leave - start);
    const toIdx = Math.min(monthlyDeficit.length, firstPension - start);
    if (toIdx <= fromIdx) continue;
    let need = 0;
    for (let i = fromIdx; i < toIdx; i++) need += monthlyDeficitAmount[i];
    const liquidAtStart = fromIdx > 0 ? monthlyLiquid[fromIdx - 1] : liquidWealthAtStart(input, items);
    bridges.push({
      personId: p.id,
      fromYear: yearOf(leave),
      toYear: yearOf(firstPension - 1),
      need,
      liquidAtStart,
      covered: liquidAtStart - need >= scenario.minLiquidWealth,
    });
  }

  const resolvedMilestones: ResolvedMilestone[] = input.milestones
    .filter((m) => resolved.has(m.id))
    .map((m) => {
      const mi = resolved.get(m.id)!;
      const p = ctx.persons.get(m.personId);
      return {
        id: m.id,
        personId: m.personId,
        kind: m.kind,
        label: m.label,
        date: ymString(mi),
        year: yearOf(mi),
        age: p ? ageAt(p.birthDate, mi) : 0,
      };
    });

  const last = years[years.length - 1];
  return {
    startYear,
    endYear,
    years,
    sources,
    pots: POTS,
    milestones: resolvedMilestones,
    bridges,
    ok: failYear === null,
    failYear,
    potDryYear,
    finalWealth: last ? last.wealthEnd : 0,
  };
}

function liquidWealthAtStart(_input: ForecastInput, items: ForecastItem[]): number {
  let s = 0;
  for (const it of items) if (it.type === "asset" && LIQUID.has(it.pot)) s += it.currentValue;
  return s;
}

// -----------------------------------------------------------------------
// Searches on top of the simulation
// -----------------------------------------------------------------------

function withLeaveAge(input: ForecastInput, personId: number, age: number): ForecastInput {
  const ms = input.milestones.find((m) => m.personId === personId && m.kind === "leave_work");
  if (!ms) return input;
  return {
    ...input,
    scenario: {
      ...input.scenario,
      milestoneOverrides: {
        ...input.scenario.milestoneOverrides,
        [String(ms.id)]: { age, date: null },
      },
    },
  };
}

/**
 * Earliest age at which `personId` can leave work so that the money lasts.
 * Tries every age from the person's current age to `maxAge`; null when none works.
 */
export function earliestLeaveAge(
  input: ForecastInput,
  personId: number,
  maxAge = 70,
): { age: number | null; tried: Array<{ age: number; ok: boolean; finalWealth: number }> } {
  const p = input.persons.find((x) => x.id === personId);
  const tried: Array<{ age: number; ok: boolean; finalWealth: number }> = [];
  if (!p) return { age: null, tried };
  const startDate = input.startDate ?? isoToday();
  const currentAge = ageAt(p.birthDate, monthIndex(startDate));
  for (let age = Math.max(currentAge, 40); age <= maxAge; age++) {
    const res = simulate(withLeaveAge(input, personId, age));
    tried.push({ age, ok: res.ok, finalWealth: res.finalWealth });
    if (res.ok) return { age, tried };
  }
  return { age: null, tried };
}

/** Leave-work age of A × leave-work age of B — the heatmap of the issue. */
export function leaveAgeMatrix(
  input: ForecastInput,
  personA: number,
  personB: number,
  agesA: number[],
  agesB: number[],
): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const ageA of agesA) {
    const withA = withLeaveAge(input, personA, ageA);
    for (const ageB of agesB) {
      const res = simulate(withLeaveAge(withA, personB, ageB));
      cells.push({ ageA, ageB, ok: res.ok, finalWealth: res.finalWealth, failYear: res.failYear });
    }
  }
  return cells;
}

/** Nominal → today's purchasing power. */
export function deflate(value: number, year: number, startYear: number, inflationRate: number): number {
  return value / Math.pow(1 + inflationRate, year - startYear);
}

export function defaultScenario(overrides: Partial<ForecastScenario> = {}): ForecastScenario {
  return {
    name: "Standard",
    inflationRate: 0.02,
    defaultReturnRate: 0.04,
    capitalGainsTaxRate: 0.26375,
    depotGainShare: 0.5,
    minLiquidWealth: 0,
    endAge: 95,
    milestoneOverrides: {},
    withdrawalOrder: ["cash", "depot", "other"],
    allowSurrender: false,
    spendingCurve: {
      referencePersonId: null,
      phases: [
        { fromAge: 0, factor: 1 },
        { fromAge: 75, factor: 0.85 },
        { fromAge: 85, factor: 0.75 },
      ],
      careFromAge: 85,
      careMonthly: 0,
    },
    healthInsurance: { rate: 0.2, minMonthly: 250 },
    offsetDeductions: [],
    ...overrides,
  };
}
