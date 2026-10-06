// Retirement forecast — persistence and API (issue #1337).
//
// Persons, milestones, items and scenarios are per user. The simulation
// itself lives in forecast-engine.ts; this file loads the household,
// fills linked account balances in, and runs the engine on request. The
// slider in the UI sends its scenario inline, so nothing has to be saved
// to see what a change does.

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, desc, eq, inArray, isNull, max, sum } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountHolding,
  financeAccountType,
  financeForecastItem,
  financeForecastMilestone,
  financeForecastPerson,
  financeForecastScenario,
  users,
} from "../db/schema";
import {
  leverAnalysis,
  reverseCalculation,
  sensitivityTable,
  survivorCheck,
  withoutDeath,
  type LeverAnalysis,
  type ReverseResult,
  type SensitivityTable,
  type SurvivorCheck,
} from "./forecast-analysis";
import {
  ageAtStart,
  defaultScenario,
  earliestLeaveAge,
  leaveAgeMatrix,
  simulate,
  type ForecastItem,
  type ForecastMilestone,
  type ForecastPerson,
  type ForecastScenario,
  type ItemType,
  type MatrixCell,
  type MilestoneKind,
  type SimulationResult,
  type TimeRef,
} from "./forecast-engine";
import { resolveHousehold, type HouseholdAccess, type HouseholdRole } from "./forecast-household.service";

console.log("[boot] finance/forecast.ts: all imports resolved");

// -----------------------------------------------------------------------
// DTOs
// -----------------------------------------------------------------------

export interface PersonDto {
  id: number;
  label: string;
  birthDate: string;
  sortOrder: number;
}

export interface MilestoneDto {
  id: number;
  personId: number;
  kind: MilestoneKind;
  label: string;
  date: string | null;
  age: number | null;
}


export interface ItemDto {
  id: number;
  personId: number | null;
  type: ItemType;
  label: string;
  /** Type-specific fields, see ForecastItem in forecast-engine.ts. */
  data: Record<string, unknown>;
  linkedAccountId: number | null;
  /** Latest balance of the linked account, when there is one. */
  linkedAccountBalance: number | null;
  sortOrder: number;
}

export interface ScenarioDto {
  id: number;
  name: string;
  config: Record<string, unknown>;
  updatedAt: string;
}

export interface LinkableAccount {
  id: number;
  label: string;
  balance: number | null;
  /** finance_account_kind: giro, tagesgeld, festgeld, depot, bausparen, … */
  kind: string;
}

export interface ForecastBundle {
  persons: PersonDto[];
  milestones: MilestoneDto[];
  items: ItemDto[];
  scenarios: ScenarioDto[];
  accounts: LinkableAccount[];
  /** Whose forecast this is: the caller's own, or one shared with them. */
  household: { role: HouseholdRole; ownerName: string | null };
  /** The scenario the UI starts with when the user has none saved. */
  defaultScenario: Record<string, unknown>;
}

interface PersonInput {
  label: string;
  birthDate: string;
  sortOrder?: number;
}

// Update shapes are spelled out: Encore's parser reads these interfaces
// itself and utility types like Partial<> are not something to lean on there.
interface PersonUpdate {
  id: number;
  label?: string;
  birthDate?: string;
  sortOrder?: number;
}

interface MilestoneInput {
  personId: number;
  kind: MilestoneKind;
  label?: string;
  date?: string | null;
  age?: number | null;
}

interface MilestoneUpdate {
  id: number;
  personId?: number;
  kind?: MilestoneKind;
  label?: string;
  date?: string | null;
  age?: number | null;
}

interface ItemInput {
  personId?: number | null;
  type: ItemType;
  label: string;
  data: Record<string, unknown>;
  linkedAccountId?: number | null;
  sortOrder?: number;
}

interface ItemUpdate {
  id: number;
  personId?: number | null;
  type?: ItemType;
  label?: string;
  data?: Record<string, unknown>;
  linkedAccountId?: number | null;
  sortOrder?: number;
}

interface ScenarioInput {
  name: string;
  config: Record<string, unknown>;
}

interface ScenarioUpdate {
  id: number;
  name?: string;
  config?: Record<string, unknown>;
}

interface IdRequest {
  id: number;
}

export interface SimulateRequest {
  /** Saved scenario to run; ignored when `scenario` is given. */
  scenarioId?: number;
  /** Inline scenario config — what the sliders send. */
  scenario?: Record<string, unknown>;
  /** Also compute the earliest leave-work age of this person. */
  earliestFor?: number;
  /** Also compute the two-person matrix. */
  matrix?: { personA: number; personB: number; fromAge: number; toAge: number };
  /** Also run these saved scenarios for the comparison chart. */
  compareScenarioIds?: number[];
  /** Also compute the sensitivity table and the levers for `earliestFor` (#1339). */
  robustness?: boolean;
  /** Also answer "what does it take to leave at this age?" for `earliestFor` (#1340). */
  targetAge?: number;
  /** Also simulate the death of this person at every age from now on (#1341). */
  survivorFor?: number;
}

export interface EarliestResult {
  personId: number;
  age: number | null;
}

export interface ComparisonRun {
  scenarioId: number;
  name: string;
  result: SimulationResult;
}

export interface SimulateResponse {
  result: SimulationResult;
  earliest: EarliestResult | null;
  matrix: MatrixCell[] | null;
  comparisons: ComparisonRun[];
  sensitivity: SensitivityTable | null;
  levers: LeverAnalysis | null;
  reverse: ReverseResult | null;
  survivor: SurvivorCheck | null;
}

// -----------------------------------------------------------------------
// Normalisation — jsonb in, engine types out
// -----------------------------------------------------------------------

const MILESTONE_KINDS: MilestoneKind[] = [
  "leave_work",
  "statutory_pension",
  "company_pension",
  "private_pension",
  "life_insurance_maturity",
  "custom",
];

const ITEM_TYPES: ItemType[] = [
  "salary",
  "income",
  "expense",
  "living_expense",
  "health_insurance",
  "asset",
  "life_insurance",
  "pension",
];

const MILESTONE_LABELS: Record<MilestoneKind, string> = {
  leave_work: "Ausstieg aus dem Beruf",
  statutory_pension: "Gesetzliche Rente",
  company_pension: "Betriebsrente",
  private_pension: "Private Rente",
  life_insurance_maturity: "Ablauf Lebensversicherung",
  custom: "Zeitpunkt",
};

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function timeRef(v: unknown): TimeRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "milestone" && typeof o.milestoneId === "number") {
    return { kind: "milestone", milestoneId: o.milestoneId };
  }
  if (o.kind === "date" && isIsoDate(o.date)) return { kind: "date", date: o.date };
  if (o.kind === "age" && typeof o.personId === "number" && typeof o.age === "number") {
    return { kind: "age", personId: o.personId, age: o.age };
  }
  return null;
}

const HI_MODES = ["employed", "statutory_voluntary", "family", "kvdr", "private"] as const;
const POTS = ["cash", "depot", "real_estate", "other"] as const;
const FREQ = ["monthly", "yearly", "once"] as const;

/**
 * Builds the engine item from a row. Unknown or missing fields fall back
 * to harmless defaults so that an item saved by an older client still
 * simulates. Personal item types need a person; the API enforces that on
 * write, and this function trusts the row.
 */
export function toEngineItem(
  row: {
    id: number;
    person_id: number | null;
    type: ItemType;
    label: string;
    data: Record<string, unknown>;
    linked_account_id: number | null;
  },
  linkedBalance: number | null,
): ForecastItem | null {
  const d = row.data ?? {};
  const base = {
    id: row.id,
    label: row.label,
    personId: row.person_id,
    start: timeRef(d.start),
    end: timeRef(d.end),
  };
  const pid = row.person_id;
  switch (row.type) {
    case "salary":
      if (pid == null) return null;
      return { ...base, type: "salary", personId: pid, amount: num(d.amount, 0), growthRate: num(d.growthRate, 0) };
    case "income":
      return {
        ...base,
        type: "income",
        amount: num(d.amount, 0),
        frequency: str(d.frequency, FREQ, "monthly"),
        growthRate: num(d.growthRate, 0),
        taxRate: num(d.taxRate, 0),
      };
    case "expense":
      return {
        ...base,
        type: "expense",
        amount: num(d.amount, 0),
        frequency: str(d.frequency, FREQ, "monthly"),
        growthRate: numOrNull(d.growthRate),
      };
    case "living_expense":
      return { ...base, type: "living_expense", personId: null, amount: num(d.amount, 0) };
    case "health_insurance":
      if (pid == null) return null;
      return {
        ...base,
        type: "health_insurance",
        personId: pid,
        employedAmount: num(d.employedAmount, 0),
        bridgeMode: str(d.bridgeMode, HI_MODES, "statutory_voluntary"),
        bridgeAmount: num(d.bridgeAmount, 0),
        retiredMode: str(d.retiredMode, HI_MODES, "kvdr"),
        retiredAmount: num(d.retiredAmount, 0),
        privateGrowthRate: num(d.privateGrowthRate, 0),
      };
    case "asset":
      return {
        ...base,
        type: "asset",
        pot: str(d.pot, POTS, "cash"),
        // A negative balance (an overdrawn account) is a debt, not an asset to draw on.
        currentValue: Math.max(0, linkedBalance ?? num(d.currentValue, 0)),
        returnRate: numOrNull(d.returnRate),
        monthlyContribution: num(d.monthlyContribution, 0),
        contributionEnd: timeRef(d.contributionEnd),
        linkedAccountId: row.linked_account_id,
      };
    case "life_insurance": {
      if (pid == null) return null;
      const maturity = timeRef(d.maturity);
      if (!maturity) return null;
      return {
        ...base,
        type: "life_insurance",
        personId: pid,
        surrenderValue: num(d.surrenderValue, 0),
        monthlyPremium: num(d.monthlyPremium, 0),
        premiumEnd: timeRef(d.premiumEnd),
        guaranteedPayout: num(d.guaranteedPayout, 0),
        projectedPayout: num(d.projectedPayout, num(d.guaranteedPayout, 0)),
        deathBenefit: numOrNull(d.deathBenefit),
        maturity,
        payoutMode: str(d.payoutMode, ["lump_sum", "annuity"] as const, "lump_sum"),
        annuityAmount: num(d.annuityAmount, 0),
        taxRate: num(d.taxRate, 0),
      };
    }
    case "pension": {
      if (pid == null) return null;
      const start = timeRef(d.start);
      if (!start) return null;
      return {
        ...base,
        type: "pension",
        personId: pid,
        kind: str(d.kind, ["statutory", "company", "private"] as const, "statutory"),
        monthlyAmount: num(d.monthlyAmount, 0),
        currentEntitlement: numOrNull(d.currentEntitlement),
        survivorShare: numOrNull(d.survivorShare),
        start,
        regularAge: numOrNull(d.regularAge),
        deductionPerMonth: num(d.deductionPerMonth, 0),
        deductionOffsetCost: numOrNull(d.deductionOffsetCost),
        growthRate: num(d.growthRate, 0),
        monthlyContribution: num(d.monthlyContribution, 0),
        contributionEnd: timeRef(d.contributionEnd),
        lumpSumOption: numOrNull(d.lumpSumOption),
        payoutMode: str(d.payoutMode, ["annuity", "lump_sum"] as const, "annuity"),
        taxRate: num(d.taxRate, 0),
      };
    }
  }
}

/** Scenario config from jsonb, with every field defaulted. */
export function toEngineScenario(config: Record<string, unknown>, name = "Szenario", id?: number): ForecastScenario {
  const base = defaultScenario();
  const c = config ?? {};
  const overridesIn = (c.milestoneOverrides && typeof c.milestoneOverrides === "object" ? c.milestoneOverrides : {}) as Record<
    string,
    unknown
  >;
  const milestoneOverrides: ForecastScenario["milestoneOverrides"] = {};
  for (const [k, v] of Object.entries(overridesIn)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const entry: { date?: string | null; age?: number | null } = {};
    if (isIsoDate(o.date)) entry.date = o.date;
    else if (o.date === null) entry.date = null;
    if (typeof o.age === "number") entry.age = o.age;
    else if (o.age === null) entry.age = null;
    if (entry.date !== undefined || entry.age !== undefined) milestoneOverrides[k] = entry;
  }
  const sc = (c.spendingCurve && typeof c.spendingCurve === "object" ? c.spendingCurve : {}) as Record<string, unknown>;
  const phasesIn = Array.isArray(sc.phases) ? sc.phases : base.spendingCurve.phases;
  const phases = phasesIn
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({ fromAge: num(p.fromAge, 0), factor: num(p.factor, 1) }));
  const hi = (c.healthInsurance && typeof c.healthInsurance === "object" ? c.healthInsurance : {}) as Record<string, unknown>;
  const orderIn = Array.isArray(c.withdrawalOrder) ? c.withdrawalOrder : base.withdrawalOrder;
  const withdrawalOrder = orderIn.filter((p): p is (typeof POTS)[number] => (POTS as readonly string[]).includes(String(p)));
  const offsets = Array.isArray(c.offsetDeductions) ? c.offsetDeductions.filter((x): x is number => typeof x === "number") : [];
  const st = (c.stress && typeof c.stress === "object" ? c.stress : {}) as Record<string, unknown>;
  const sv = (c.survivor && typeof c.survivor === "object" ? c.survivor : {}) as Record<string, unknown>;
  return {
    id,
    name,
    inflationRate: num(c.inflationRate, base.inflationRate),
    defaultReturnRate: num(c.defaultReturnRate, base.defaultReturnRate),
    capitalGainsTaxRate: num(c.capitalGainsTaxRate, base.capitalGainsTaxRate),
    depotGainShare: num(c.depotGainShare, base.depotGainShare),
    minLiquidWealth: num(c.minLiquidWealth, base.minLiquidWealth),
    endAge: Math.min(120, Math.max(50, num(c.endAge, base.endAge))),
    milestoneOverrides,
    withdrawalOrder: withdrawalOrder.length ? withdrawalOrder : base.withdrawalOrder,
    allowSurrender: c.allowSurrender === true,
    spendingCurve: {
      referencePersonId: numOrNull(sc.referencePersonId),
      phases: phases.length ? phases : base.spendingCurve.phases,
      careFromAge: numOrNull(sc.careFromAge),
      careMonthly: num(sc.careMonthly, 0),
    },
    healthInsurance: {
      rate: num(hi.rate, base.healthInsurance.rate),
      careRate: Math.min(num(hi.careRate, base.healthInsurance.careRate), num(hi.rate, base.healthInsurance.rate)),
      minMonthly: num(hi.minMonthly, base.healthInsurance.minMonthly),
      maxMonthlyIncome: num(hi.maxMonthlyIncome, base.healthInsurance.maxMonthlyIncome),
    },
    offsetDeductions: offsets,
    stress: {
      crashYear: st.crashYear == null ? null : Math.round(num(st.crashYear, 0)),
      crashSize: Math.min(0.99, Math.max(0, num(st.crashSize, base.stress.crashSize))),
    },
    survivor: {
      personId: numOrNull(sv.personId),
      age: sv.age == null ? null : Math.round(num(sv.age, 0)),
      expenseFactor: Math.min(1.5, Math.max(0, num(sv.expenseFactor, base.survivor.expenseFactor))),
      incomeOffsetRate: Math.min(1, Math.max(0, num(sv.incomeOffsetRate, base.survivor.incomeOffsetRate))),
      incomeAllowance: Math.max(0, num(sv.incomeAllowance, base.survivor.incomeAllowance)),
    },
  };
}

// -----------------------------------------------------------------------
// Loading the household
// -----------------------------------------------------------------------

function toPersonDto(row: typeof financeForecastPerson.$inferSelect): PersonDto {
  return { id: row.id, label: row.label, birthDate: row.birth_date, sortOrder: row.sort_order };
}

function toMilestoneDto(row: typeof financeForecastMilestone.$inferSelect): MilestoneDto {
  return { id: row.id, personId: row.person_id, kind: row.kind, label: row.label, date: row.date, age: row.age };
}

function toScenarioDto(row: typeof financeForecastScenario.$inferSelect): ScenarioDto {
  return { id: row.id, name: row.name, config: row.config, updatedAt: row.updated_at };
}

/** Open accounts one user may see. */
async function accountRowsOf(userId: number, isAdmin: boolean) {
  const fields = { id: financeAccount.id, label: financeAccount.label, kind: financeAccountType.kind };
  return isAdmin
    ? await db
        .select(fields)
        .from(financeAccount)
        .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id))
        .where(isNull(financeAccount.closed_at))
    : await db
        .select(fields)
        .from(financeAccount)
        .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id))
        .innerJoin(
          financeAccountAccess,
          and(eq(financeAccountAccess.account_id, financeAccount.id), eq(financeAccountAccess.user_id, userId)),
        )
        .where(isNull(financeAccount.closed_at));
}

/**
 * Accounts anyone in the household may see, with their latest balance. A
 * shared forecast shows the same balances to everyone in it: whoever links
 * an account shares its balance (never its bookings) with the household.
 */
async function linkableAccounts(access: HouseholdAccess): Promise<LinkableAccount[]> {
  const byId = new Map<number, { id: number; label: string; kind: string }>();
  for (const m of access.members) for (const r of await accountRowsOf(m.id, m.isAdmin)) byId.set(r.id, r);
  const rows = [...byId.values()];
  if (rows.length === 0) return [];
  const balances = new Map<number, number>();
  const balanceRows = await db
    .select({
      account_id: financeAccountBalance.account_id,
      balance: financeAccountBalance.balance,
    })
    .from(financeAccountBalance)
    .where(
      inArray(
        financeAccountBalance.account_id,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(financeAccountBalance.as_of));
  for (const b of balanceRows) {
    if (!balances.has(b.account_id)) balances.set(b.account_id, Number(b.balance));
  }
  // A depot whose sync writes positions but no balance: the sum of its latest positions.
  const depotsWithout = rows.filter((r) => r.kind === "depot" && !balances.has(r.id)).map((r) => r.id);
  if (depotsWithout.length > 0) {
    const latest = await db
      .select({ accountId: financeAccountHolding.account_id, asOf: max(financeAccountHolding.as_of) })
      .from(financeAccountHolding)
      .where(inArray(financeAccountHolding.account_id, depotsWithout))
      .groupBy(financeAccountHolding.account_id);
    for (const l of latest) {
      if (!l.asOf) continue;
      const [t] = await db
        .select({ total: sum(financeAccountHolding.value) })
        .from(financeAccountHolding)
        .where(and(eq(financeAccountHolding.account_id, l.accountId), eq(financeAccountHolding.as_of, l.asOf)));
      if (t?.total != null) balances.set(l.accountId, Number(t.total));
    }
  }
  return rows
    .map((r) => ({ id: r.id, label: r.label, kind: r.kind, balance: balances.get(r.id) ?? null }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface Household {
  persons: ForecastPerson[];
  milestones: ForecastMilestone[];
  items: ForecastItem[];
  personDtos: PersonDto[];
  milestoneDtos: MilestoneDto[];
  itemDtos: ItemDto[];
  accounts: LinkableAccount[];
}

export async function loadHousehold(userId: number, access: HouseholdAccess): Promise<Household> {
  const [personRows, milestoneRows, itemRows, accounts] = await Promise.all([
    db
      .select()
      .from(financeForecastPerson)
      .where(eq(financeForecastPerson.user_id, userId))
      .orderBy(asc(financeForecastPerson.sort_order), asc(financeForecastPerson.id)),
    db.select().from(financeForecastMilestone).where(eq(financeForecastMilestone.user_id, userId)).orderBy(asc(financeForecastMilestone.id)),
    db
      .select()
      .from(financeForecastItem)
      .where(eq(financeForecastItem.user_id, userId))
      .orderBy(asc(financeForecastItem.sort_order), asc(financeForecastItem.id)),
    linkableAccounts(access),
  ]);
  const balanceOf = new Map(accounts.map((a) => [a.id, a.balance]));
  const itemDtos: ItemDto[] = itemRows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    type: r.type,
    label: r.label,
    data: r.data,
    linkedAccountId: r.linked_account_id,
    linkedAccountBalance: r.linked_account_id != null ? (balanceOf.get(r.linked_account_id) ?? null) : null,
    sortOrder: r.sort_order,
  }));
  const items = itemRows
    .map((r) => toEngineItem(r, r.linked_account_id != null ? (balanceOf.get(r.linked_account_id) ?? null) : null))
    .filter((it): it is ForecastItem => it !== null);
  return {
    persons: personRows.map((p) => ({ id: p.id, label: p.label, birthDate: p.birth_date })),
    milestones: milestoneRows.map((m) => ({ id: m.id, personId: m.person_id, kind: m.kind, label: m.label, date: m.date, age: m.age })),
    items,
    personDtos: personRows.map(toPersonDto),
    milestoneDtos: milestoneRows.map(toMilestoneDto),
    itemDtos,
    accounts,
  };
}

/**
 * The caller's household. `userId` is the forecast's owner, whose rows are
 * read and written; "edit" refuses a forecast shared read-only.
 */
async function authed(mode: "view" | "edit"): Promise<{ userId: number; access: HouseholdAccess }> {
  const auth = getAuthData()!;
  requirePermission(auth, "finance.view");
  const access = await resolveHousehold(Number(auth.userID), auth.permissions.includes("finance.admin"));
  if (mode === "edit" && access.role === "view") throw APIError.permissionDenied("this forecast is shared with you read-only");
  return { userId: access.ownerId, access };
}

async function userName(id: number): Promise<string | null> {
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
  return u?.name ?? null;
}

async function ownPerson(userId: number, personId: number): Promise<void> {
  const [row] = await db
    .select({ id: financeForecastPerson.id })
    .from(financeForecastPerson)
    .where(and(eq(financeForecastPerson.id, personId), eq(financeForecastPerson.user_id, userId)));
  if (!row) throw APIError.notFound(`person ${personId} not found`);
}

async function ownAccount(access: HouseholdAccess, accountId: number): Promise<void> {
  const accounts = await linkableAccounts(access);
  if (!accounts.some((a) => a.id === accountId)) throw APIError.notFound(`account ${accountId} not found`);
}

// -----------------------------------------------------------------------
// GET /finance/forecast — everything the page needs
// -----------------------------------------------------------------------

export const getForecast = api(
  { expose: true, method: "GET", path: "/finance/forecast", auth: true },
  async (): Promise<ForecastBundle> => {
    const { userId, access } = await authed("view");
    const [hh, scenarioRows] = await Promise.all([
      loadHousehold(userId, access),
      db
        .select()
        .from(financeForecastScenario)
        .where(eq(financeForecastScenario.user_id, userId))
        .orderBy(asc(financeForecastScenario.id)),
    ]);
    const { name: _n, id: _i, ...defaults } = defaultScenario();
    return {
      persons: hh.personDtos,
      milestones: hh.milestoneDtos,
      items: hh.itemDtos,
      scenarios: scenarioRows.map(toScenarioDto),
      accounts: hh.accounts,
      household: { role: access.role, ownerName: access.role === "owner" ? null : await userName(access.ownerId) },
      defaultScenario: defaults as unknown as Record<string, unknown>,
    };
  },
);

// -----------------------------------------------------------------------
// Persons
// -----------------------------------------------------------------------

export const createPerson = api(
  { expose: true, method: "POST", path: "/finance/forecast/persons", auth: true },
  async (req: PersonInput): Promise<PersonDto> => {
    const { userId } = await authed("edit");
    if (!req.label || req.label.trim().length === 0) throw APIError.invalidArgument("label must be a non-empty string");
    if (!isIsoDate(req.birthDate)) throw APIError.invalidArgument("birthDate must be YYYY-MM-DD");
    const [row] = await db
      .insert(financeForecastPerson)
      .values({ user_id: userId, label: req.label.trim(), birth_date: req.birthDate, sort_order: req.sortOrder ?? 0 })
      .returning();
    // Every person starts with the two milestones the forecast turns on.
    const regular = regularRetirementAge(Number(req.birthDate.slice(0, 4)));
    await db.insert(financeForecastMilestone).values([
      { user_id: userId, person_id: row.id, kind: "leave_work", label: MILESTONE_LABELS.leave_work, age: Math.min(63, regular) },
      { user_id: userId, person_id: row.id, kind: "statutory_pension", label: MILESTONE_LABELS.statutory_pension, age: regular },
    ]);
    return toPersonDto(row);
  },
);

export const updatePerson = api(
  { expose: true, method: "PUT", path: "/finance/forecast/persons/:id", auth: true },
  async (req: PersonUpdate): Promise<PersonDto> => {
    const { userId } = await authed("edit");
    const updates: Partial<typeof financeForecastPerson.$inferInsert> = { updated_at: new Date().toISOString() };
    if (req.label !== undefined) {
      if (req.label.trim().length === 0) throw APIError.invalidArgument("label must be non-empty");
      updates.label = req.label.trim();
    }
    if (req.birthDate !== undefined) {
      if (!isIsoDate(req.birthDate)) throw APIError.invalidArgument("birthDate must be YYYY-MM-DD");
      updates.birth_date = req.birthDate;
    }
    if (req.sortOrder !== undefined) updates.sort_order = req.sortOrder;
    const [row] = await db
      .update(financeForecastPerson)
      .set(updates)
      .where(and(eq(financeForecastPerson.id, req.id), eq(financeForecastPerson.user_id, userId)))
      .returning();
    if (!row) throw APIError.notFound(`person ${req.id} not found`);
    return toPersonDto(row);
  },
);

export const deletePerson = api(
  { expose: true, method: "DELETE", path: "/finance/forecast/persons/:id", auth: true },
  async (req: IdRequest): Promise<void> => {
    const { userId } = await authed("edit");
    const rows = await db
      .delete(financeForecastPerson)
      .where(and(eq(financeForecastPerson.id, req.id), eq(financeForecastPerson.user_id, userId)))
      .returning({ id: financeForecastPerson.id });
    if (rows.length === 0) throw APIError.notFound(`person ${req.id} not found`);
  },
);

// -----------------------------------------------------------------------
// Milestones
// -----------------------------------------------------------------------

function validateWhen(date: string | null | undefined, age: number | null | undefined): { date: string | null; age: number | null } {
  const hasDate = isIsoDate(date);
  const hasAge = typeof age === "number" && Number.isInteger(age) && age >= 0 && age <= 120;
  if (hasDate === hasAge) throw APIError.invalidArgument("exactly one of date and age must be set");
  return { date: hasDate ? (date as string) : null, age: hasAge ? (age as number) : null };
}

export const createMilestone = api(
  { expose: true, method: "POST", path: "/finance/forecast/milestones", auth: true },
  async (req: MilestoneInput): Promise<MilestoneDto> => {
    const { userId } = await authed("edit");
    if (!MILESTONE_KINDS.includes(req.kind)) throw APIError.invalidArgument(`unknown milestone kind ${String(req.kind)}`);
    await ownPerson(userId, req.personId);
    const when = validateWhen(req.date, req.age);
    const label = req.label?.trim() || MILESTONE_LABELS[req.kind];
    const [row] = await db
      .insert(financeForecastMilestone)
      .values({ user_id: userId, person_id: req.personId, kind: req.kind, label, ...when })
      .returning();
    return toMilestoneDto(row);
  },
);

export const updateMilestone = api(
  { expose: true, method: "PUT", path: "/finance/forecast/milestones/:id", auth: true },
  async (req: MilestoneUpdate): Promise<MilestoneDto> => {
    const { userId } = await authed("edit");
    const [existing] = await db
      .select()
      .from(financeForecastMilestone)
      .where(and(eq(financeForecastMilestone.id, req.id), eq(financeForecastMilestone.user_id, userId)));
    if (!existing) throw APIError.notFound(`milestone ${req.id} not found`);
    const updates: Partial<typeof financeForecastMilestone.$inferInsert> = {};
    if (req.label !== undefined) {
      if (req.label.trim().length === 0) throw APIError.invalidArgument("label must be non-empty");
      updates.label = req.label.trim();
    }
    if (req.kind !== undefined) {
      if (!MILESTONE_KINDS.includes(req.kind)) throw APIError.invalidArgument(`unknown milestone kind ${String(req.kind)}`);
      updates.kind = req.kind;
    }
    if (req.date !== undefined || req.age !== undefined) {
      // A new date clears the age and vice versa, unless both were sent.
      const date = req.date !== undefined ? req.date : req.age != null ? null : existing.date;
      const age = req.age !== undefined ? req.age : req.date != null ? null : existing.age;
      Object.assign(updates, validateWhen(date, age));
    }
    const [row] = await db.update(financeForecastMilestone).set(updates).where(eq(financeForecastMilestone.id, req.id)).returning();
    return toMilestoneDto(row);
  },
);

export const deleteMilestone = api(
  { expose: true, method: "DELETE", path: "/finance/forecast/milestones/:id", auth: true },
  async (req: IdRequest): Promise<void> => {
    const { userId } = await authed("edit");
    const rows = await db
      .delete(financeForecastMilestone)
      .where(and(eq(financeForecastMilestone.id, req.id), eq(financeForecastMilestone.user_id, userId)))
      .returning({ id: financeForecastMilestone.id });
    if (rows.length === 0) throw APIError.notFound(`milestone ${req.id} not found`);
  },
);

// -----------------------------------------------------------------------
// Items
// -----------------------------------------------------------------------

const PERSONAL_TYPES: ReadonlySet<ItemType> = new Set(["salary", "health_insurance", "life_insurance", "pension"]);

/** Fields a statement can state; a hand edit of one of them makes the hand the source. */
const VALUE_FIELDS = [
  "surrenderValue",
  "guaranteedPayout",
  "projectedPayout",
  "monthlyPremium",
  "monthlyAmount",
  "lumpSumOption",
  "currentValue",
  "amount",
];

function manualSource(): Record<string, unknown> {
  return { kind: "manual", updatedAt: new Date().toISOString() };
}

function itemDto(row: typeof financeForecastItem.$inferSelect, balance: number | null): ItemDto {
  return {
    id: row.id,
    personId: row.person_id,
    type: row.type,
    label: row.label,
    data: row.data,
    linkedAccountId: row.linked_account_id,
    linkedAccountBalance: balance,
    sortOrder: row.sort_order,
  };
}

async function balanceOfAccount(accountId: number | null): Promise<number | null> {
  if (accountId == null) return null;
  const [row] = await db
    .select({ balance: financeAccountBalance.balance })
    .from(financeAccountBalance)
    .where(eq(financeAccountBalance.account_id, accountId))
    .orderBy(desc(financeAccountBalance.as_of))
    .limit(1);
  return row ? Number(row.balance) : null;
}

/** Runs the row through the engine mapper once, so a broken item is refused on write, not at simulation time. */
function assertSimulatable(row: { id: number; person_id: number | null; type: ItemType; label: string; data: Record<string, unknown>; linked_account_id: number | null }): void {
  if (toEngineItem(row, null) === null) {
    if (row.type === "pension") throw APIError.invalidArgument("a pension needs a start (data.start)");
    if (row.type === "life_insurance") throw APIError.invalidArgument("a life insurance needs a maturity (data.maturity)");
    throw APIError.invalidArgument(`item of type ${row.type} needs a person`);
  }
}

export const createItem = api(
  { expose: true, method: "POST", path: "/finance/forecast/items", auth: true },
  async (req: ItemInput): Promise<ItemDto> => {
    const { userId, access } = await authed("edit");
    if (!ITEM_TYPES.includes(req.type)) throw APIError.invalidArgument(`unknown item type ${String(req.type)}`);
    if (!req.label || req.label.trim().length === 0) throw APIError.invalidArgument("label must be a non-empty string");
    if (!req.data || typeof req.data !== "object") throw APIError.invalidArgument("data must be an object");
    const personId = req.personId ?? null;
    if (PERSONAL_TYPES.has(req.type) && personId == null) throw APIError.invalidArgument(`item of type ${req.type} needs a person`);
    if (personId != null) await ownPerson(userId, personId);
    const linked = req.type === "asset" ? (req.linkedAccountId ?? null) : null;
    if (linked != null) await ownAccount(access, linked);
    const data = req.data.valuesSource ? req.data : { ...req.data, valuesSource: manualSource() };
    const candidate = { id: 0, person_id: personId, type: req.type, label: req.label.trim(), data, linked_account_id: linked };
    assertSimulatable(candidate);
    const [row] = await db
      .insert(financeForecastItem)
      .values({
        user_id: userId,
        person_id: personId,
        type: req.type,
        label: candidate.label,
        data,
        linked_account_id: linked,
        sort_order: req.sortOrder ?? 0,
      })
      .returning();
    return itemDto(row, await balanceOfAccount(linked));
  },
);

export const updateItem = api(
  { expose: true, method: "PUT", path: "/finance/forecast/items/:id", auth: true },
  async (req: ItemUpdate): Promise<ItemDto> => {
    const { userId, access } = await authed("edit");
    const [existing] = await db
      .select()
      .from(financeForecastItem)
      .where(and(eq(financeForecastItem.id, req.id), eq(financeForecastItem.user_id, userId)));
    if (!existing) throw APIError.notFound(`item ${req.id} not found`);
    const next = { ...existing };
    if (req.label !== undefined) {
      if (req.label.trim().length === 0) throw APIError.invalidArgument("label must be non-empty");
      next.label = req.label.trim();
    }
    if (req.data !== undefined) {
      if (!req.data || typeof req.data !== "object") throw APIError.invalidArgument("data must be an object");
      // Editing a value by hand makes the hand the source; editing the label or dates does not.
      const changed = VALUE_FIELDS.some((k) => JSON.stringify(req.data![k] ?? null) !== JSON.stringify(existing.data[k] ?? null));
      next.data = changed ? { ...req.data, valuesSource: manualSource() } : { ...req.data, valuesSource: existing.data.valuesSource ?? req.data.valuesSource };
      // Recorded in the statements dialog, never by the item dialog: keep what is stored.
      if (existing.data.declinedIncreases !== undefined) next.data = { ...next.data, declinedIncreases: existing.data.declinedIncreases };
      else delete (next.data as Record<string, unknown>).declinedIncreases;
    }
    if (req.personId !== undefined) {
      if (req.personId != null) await ownPerson(userId, req.personId);
      next.person_id = req.personId;
    }
    if (req.linkedAccountId !== undefined) {
      if (req.linkedAccountId != null) await ownAccount(access, req.linkedAccountId);
      next.linked_account_id = existing.type === "asset" ? req.linkedAccountId : null;
    }
    if (req.sortOrder !== undefined) next.sort_order = req.sortOrder;
    if (PERSONAL_TYPES.has(existing.type) && next.person_id == null) {
      throw APIError.invalidArgument(`item of type ${existing.type} needs a person`);
    }
    assertSimulatable(next);
    const [row] = await db
      .update(financeForecastItem)
      .set({
        label: next.label,
        data: next.data,
        person_id: next.person_id,
        linked_account_id: next.linked_account_id,
        sort_order: next.sort_order,
        updated_at: new Date().toISOString(),
      })
      .where(eq(financeForecastItem.id, req.id))
      .returning();
    return itemDto(row, await balanceOfAccount(row.linked_account_id));
  },
);

export const deleteItem = api(
  { expose: true, method: "DELETE", path: "/finance/forecast/items/:id", auth: true },
  async (req: IdRequest): Promise<void> => {
    const { userId } = await authed("edit");
    const rows = await db
      .delete(financeForecastItem)
      .where(and(eq(financeForecastItem.id, req.id), eq(financeForecastItem.user_id, userId)))
      .returning({ id: financeForecastItem.id });
    if (rows.length === 0) throw APIError.notFound(`item ${req.id} not found`);
  },
);

// -----------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------

export const createScenario = api(
  { expose: true, method: "POST", path: "/finance/forecast/scenarios", auth: true },
  async (req: ScenarioInput): Promise<ScenarioDto> => {
    const { userId } = await authed("edit");
    if (!req.name || req.name.trim().length === 0) throw APIError.invalidArgument("name must be a non-empty string");
    if (!req.config || typeof req.config !== "object") throw APIError.invalidArgument("config must be an object");
    const [row] = await db
      .insert(financeForecastScenario)
      .values({ user_id: userId, name: req.name.trim(), config: req.config })
      .returning();
    return toScenarioDto(row);
  },
);

export const updateScenario = api(
  { expose: true, method: "PUT", path: "/finance/forecast/scenarios/:id", auth: true },
  async (req: ScenarioUpdate): Promise<ScenarioDto> => {
    const { userId } = await authed("edit");
    const updates: Partial<typeof financeForecastScenario.$inferInsert> = { updated_at: new Date().toISOString() };
    if (req.name !== undefined) {
      if (req.name.trim().length === 0) throw APIError.invalidArgument("name must be non-empty");
      updates.name = req.name.trim();
    }
    if (req.config !== undefined) {
      if (!req.config || typeof req.config !== "object") throw APIError.invalidArgument("config must be an object");
      updates.config = req.config;
    }
    const [row] = await db
      .update(financeForecastScenario)
      .set(updates)
      .where(and(eq(financeForecastScenario.id, req.id), eq(financeForecastScenario.user_id, userId)))
      .returning();
    if (!row) throw APIError.notFound(`scenario ${req.id} not found`);
    return toScenarioDto(row);
  },
);

export const deleteScenario = api(
  { expose: true, method: "DELETE", path: "/finance/forecast/scenarios/:id", auth: true },
  async (req: IdRequest): Promise<void> => {
    const { userId } = await authed("edit");
    const rows = await db
      .delete(financeForecastScenario)
      .where(and(eq(financeForecastScenario.id, req.id), eq(financeForecastScenario.user_id, userId)))
      .returning({ id: financeForecastScenario.id });
    if (rows.length === 0) throw APIError.notFound(`scenario ${req.id} not found`);
  },
);

// -----------------------------------------------------------------------
// POST /finance/forecast/simulate
// -----------------------------------------------------------------------

export const runSimulation = api(
  { expose: true, method: "POST", path: "/finance/forecast/simulate", auth: true },
  async (req: SimulateRequest): Promise<SimulateResponse> => {
    const { userId, access } = await authed("view");
    const hh = await loadHousehold(userId, access);
    if (hh.persons.length === 0) throw APIError.failedPrecondition("add a person first");

    const scenarioRows = await db
      .select()
      .from(financeForecastScenario)
      .where(eq(financeForecastScenario.user_id, userId));
    const byId = new Map(scenarioRows.map((s) => [s.id, s]));

    let scenario: ForecastScenario;
    if (req.scenario) {
      scenario = toEngineScenario(req.scenario, "Aktuell");
    } else if (req.scenarioId != null) {
      const row = byId.get(req.scenarioId);
      if (!row) throw APIError.notFound(`scenario ${req.scenarioId} not found`);
      scenario = toEngineScenario(row.config, row.name, row.id);
    } else {
      scenario = defaultScenario();
    }

    const input = { persons: hh.persons, milestones: hh.milestones, items: hh.items, scenario };
    const result = simulate(input);

    let earliest: SimulateResponse["earliest"] = null;
    if (req.earliestFor != null) {
      if (!hh.persons.some((p) => p.id === req.earliestFor)) throw APIError.notFound(`person ${req.earliestFor} not found`);
      earliest = { personId: req.earliestFor, age: earliestLeaveAge(input, req.earliestFor, 75).age };
    }

    let matrix: MatrixCell[] | null = null;
    if (req.matrix) {
      const { personA, personB, fromAge, toAge } = req.matrix;
      if (personA === personB) throw APIError.invalidArgument("matrix needs two different persons");
      for (const pid of [personA, personB]) {
        if (!hh.persons.some((p) => p.id === pid)) throw APIError.notFound(`person ${pid} not found`);
      }
      const span = Math.max(0, Math.min(15, Math.floor(toAge) - Math.floor(fromAge)));
      const ages = Array.from({ length: span + 1 }, (_, i) => Math.floor(fromAge) + i);
      matrix = leaveAgeMatrix(input, personA, personB, ages, ages);
    }

    const comparisons: SimulateResponse["comparisons"] = [];
    // A survivor scenario is read against the same household without the death.
    if (result.death) comparisons.push({ scenarioId: 0, name: "Ohne Todesfall", result: simulate(withoutDeath(input)) });
    for (const id of req.compareScenarioIds ?? []) {
      const row = byId.get(id);
      if (!row) continue;
      comparisons.push({
        scenarioId: row.id,
        name: row.name,
        result: simulate({ ...input, scenario: toEngineScenario(row.config, row.name, row.id) }),
      });
    }

    let sensitivity: SensitivityTable | null = null;
    let levers: LeverAnalysis | null = null;
    let reverse: ReverseResult | null = null;
    if (req.earliestFor != null && (req.robustness || req.targetAge != null)) {
      const pid = req.earliestFor;
      if (req.robustness) {
        sensitivity = sensitivityTable(input, pid);
        levers = leverAnalysis(input, pid);
      }
      if (req.targetAge != null) {
        const age = Math.floor(req.targetAge);
        const current = ageAtStart(input, pid) ?? 0;
        if (age < Math.max(40, current) || age > 80) {
          throw APIError.invalidArgument(`target age must be between ${Math.max(40, current)} and 80`);
        }
        reverse = reverseCalculation(input, pid, age);
      }
    }

    let survivor: SurvivorCheck | null = null;
    if (req.survivorFor != null) {
      if (!hh.persons.some((p) => p.id === req.survivorFor)) throw APIError.notFound(`person ${req.survivorFor} not found`);
      survivor = survivorCheck(input, req.survivorFor);
    }

    return { result, earliest, matrix, comparisons, sensitivity, levers, reverse, survivor };
  },
);

// -----------------------------------------------------------------------
// Savings accounts as asset items
// -----------------------------------------------------------------------

/** Account kinds that hold wealth rather than running money, and the pot each goes to. */
const SAVINGS_POT: Record<string, "cash" | "depot" | "other"> = {
  giro: "cash",
  bargeld: "cash",
  tagesgeld: "cash",
  festgeld: "cash",
  bausparen: "other",
  depot: "depot",
};

/**
 * Regular retirement age of the statutory pension by birth year (§ 35, § 235
 * SGB VI), in whole years: 65 up to 1946, rising to 67 from 1964 on. The
 * months in between are rounded to the nearer year.
 */
export function regularRetirementAge(birthYear: number): number {
  if (birthYear <= 1946) return 65;
  if (birthYear >= 1964) return 67;
  const months = birthYear <= 1958 ? birthYear - 1946 : 12 + (birthYear - 1958) * 2;
  return 65 + Math.round(months / 12);
}

interface AccountItemsRequest {
  accounts: Array<{ accountId: number; personId: number | null }>;
}

/** Savings and depot accounts the user may see that no forecast item is linked to yet. */
export const getAccountSuggestions = api(
  { expose: true, method: "GET", path: "/finance/forecast/account-suggestions", auth: true },
  async (): Promise<{ accounts: LinkableAccount[] }> => {
    const { userId, access } = await authed("view");
    const [accounts, linked] = await Promise.all([
      linkableAccounts(access),
      db
        .select({ id: financeForecastItem.linked_account_id })
        .from(financeForecastItem)
        .where(eq(financeForecastItem.user_id, userId)),
    ]);
    const taken = new Set(linked.map((l) => l.id).filter((id): id is number => id != null));
    return { accounts: accounts.filter((a) => a.kind in SAVINGS_POT && !taken.has(a.id)) };
  },
);

/** One asset item per chosen account, linked so its balance stays current. */
export const createAccountItems = api(
  { expose: true, method: "POST", path: "/finance/forecast/account-items", auth: true },
  async (req: AccountItemsRequest): Promise<{ created: number }> => {
    const { userId, access } = await authed("edit");
    const chosen = Array.isArray(req.accounts) ? req.accounts : [];
    if (chosen.length === 0) return { created: 0 };
    const accounts = new Map((await linkableAccounts(access)).map((a) => [a.id, a]));
    for (const c of chosen) {
      if (!accounts.has(c.accountId)) throw APIError.notFound(`account ${c.accountId} not found`);
      if (c.personId != null) await ownPerson(userId, c.personId);
    }
    const now = new Date().toISOString();
    await db.insert(financeForecastItem).values(
      chosen.map((c, i) => {
        const a = accounts.get(c.accountId)!;
        return {
          user_id: userId,
          person_id: c.personId,
          type: "asset" as const,
          label: a.label,
          data: { pot: SAVINGS_POT[a.kind] ?? "other", valuesSource: { kind: "manual", updatedAt: now } },
          linked_account_id: a.id,
          sort_order: i,
        };
      }),
    );
    return { created: chosen.length };
  },
);
