/**
 * A transaction report in groups, with subtotals, a grand total and,
 * optionally, a yield (documentation/plans/ki-assistent.md, stage 6, #1533).
 *
 * The grouping is the model's — which booking is "Kauf", which "Reparatur" —
 * but every number is computed here: the model never adds anything up.
 * Amounts are summed in cents, so a subtotal of many bookings is exact.
 *
 * Yield, as printed on the report:
 *   investment = −(sum of the investment group)   (money out is negative)
 *   net income = sum of the income groups + sum of the cost groups
 *   total      = net income ÷ investment
 *   per year   = total ÷ years, years = days from the first investment
 *                booking to the report date ÷ 365.25
 * Simple, not compounded: over a short span compounding would inflate the
 * figure, and the simple one is what can be checked with a pocket calculator.
 */

/** One booking as the report needs it. */
export interface ReportBooking {
  id: number;
  booking_date: string;
  counterparty: string | null;
  purpose: string | null;
  amount: string;
  currency_code: string;
}

export interface ReportGroupInput {
  name: string;
  transaction_ids: number[];
}

export interface YieldInput {
  investment_group: string;
  income_groups: string[];
  cost_groups: string[];
}

export interface ReportGroup {
  name: string;
  count: number;
  /** Cents. */
  subtotal: number;
  bookings: ReportBooking[];
}

export interface ReportYield {
  /** Cents, positive: what went in. */
  investment: number;
  income: number;
  costs: number;
  net: number;
  /** Fractions: 0.02 = 2 %. */
  total: number;
  per_year: number;
  from: string;
  to: string;
  days: number;
  years: number;
  /** The formula with its numbers, as printed. */
  formula: string;
}

export interface GroupedReport {
  title: string;
  currency: string;
  groups: ReportGroup[];
  /** Cents. */
  total: number;
  count: number;
  yield: ReportYield | null;
  generated_on: string;
}

export const OTHER_GROUP = "Sonstige";

export class ReportInputError extends Error {}

export function cents(amount: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new ReportInputError(`amount ${amount} is not a number`);
  return Math.round(n * 100);
}

export function euro(centsValue: number, currency = "EUR"): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(centsValue / 100);
}

function percent(fraction: number): string {
  return `${new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(fraction * 100)} %`;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * Builds the report. `all` holds every booking the report is about; those no
 * group names land in "Sonstige", listed like the rest, never dropped.
 */
export function buildGroupedReport(input: {
  title: string;
  groups: ReportGroupInput[];
  bookings: ReportBooking[];
  /** Ids of the bookings the report covers beyond the groups; default: the groups' own. */
  all?: number[];
  yield?: YieldInput | null;
  today: string;
}): GroupedReport {
  const byId = new Map(input.bookings.map((b) => [b.id, b]));
  const names = new Set<string>();
  const placed = new Map<number, string>();
  for (const g of input.groups) {
    const name = g.name.trim();
    if (!name) throw new ReportInputError("every group needs a name");
    if (name === OTHER_GROUP) throw new ReportInputError(`"${OTHER_GROUP}" is filled by the report itself`);
    if (names.has(name)) throw new ReportInputError(`group "${name}" is named twice`);
    names.add(name);
    for (const id of g.transaction_ids) {
      const before = placed.get(id);
      if (before !== undefined) throw new ReportInputError(`booking ${id} is in "${before}" and "${name}"`);
      placed.set(id, name);
    }
  }
  const missing = [...new Set([...placed.keys(), ...(input.all ?? [])])].filter((id) => !byId.has(id));
  if (missing.length) throw new ReportInputError(`bookings not found: ${missing.slice(0, 10).join(", ")}`);

  const currencies = new Set(input.bookings.map((b) => b.currency_code));
  if (currencies.size > 1) throw new ReportInputError(`bookings in more than one currency: ${[...currencies].join(", ")}`);
  const currency = [...currencies][0] ?? "EUR";

  const sortByDate = (a: ReportBooking, b: ReportBooking) =>
    a.booking_date.localeCompare(b.booking_date) || a.id - b.id;
  const group = (name: string, ids: number[]): ReportGroup => {
    const bookings = ids.map((id) => byId.get(id)!).sort(sortByDate);
    return { name, count: bookings.length, subtotal: bookings.reduce((s, b) => s + cents(b.amount), 0), bookings };
  };
  const groups = input.groups.map((g) => group(g.name.trim(), [...new Set(g.transaction_ids)]));
  const rest = [...new Set(input.all ?? [])].filter((id) => !placed.has(id));
  if (rest.length) groups.push(group(OTHER_GROUP, rest));

  const total = groups.reduce((s, g) => s + g.subtotal, 0);
  const count = groups.reduce((s, g) => s + g.count, 0);
  return {
    title: input.title.trim() || "Bericht",
    currency,
    groups,
    total,
    count,
    yield: input.yield ? computeYield(groups, input.yield, input.today, currency) : null,
    generated_on: input.today,
  };
}

function computeYield(groups: ReportGroup[], spec: YieldInput, today: string, currency: string): ReportYield {
  const find = (name: string) => {
    const g = groups.find((x) => x.name === name);
    if (!g) throw new ReportInputError(`yield names group "${name}", which the report does not have`);
    return g;
  };
  const investmentGroup = find(spec.investment_group);
  const income = spec.income_groups.map(find).reduce((s, g) => s + g.subtotal, 0);
  const costs = spec.cost_groups.map(find).reduce((s, g) => s + g.subtotal, 0);
  const investment = -investmentGroup.subtotal;
  if (investment <= 0) {
    throw new ReportInputError(`the investment group "${investmentGroup.name}" holds no money paid out`);
  }
  const from = dayOf(investmentGroup.bookings[0].booking_date);
  const days = Math.max(1, daysBetween(from, today));
  const years = days / 365.25;
  const net = income + costs;
  const total = net / investment;
  const perYear = total / years;
  const yearsText = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(years);
  const formula = [
    `Rendite = (Einnahmen + Kosten) ÷ Investition = (${euro(income, currency)} + ${euro(costs, currency)}) ÷ ${euro(investment, currency)} = ${percent(total)}`,
    `Rendite p. a. = ${percent(total)} ÷ ${yearsText} Jahre (${days} Tage vom ${germanDate(from)} bis ${germanDate(today)}) = ${percent(perYear)}`,
  ].join("\n");
  return { investment, income, costs, net, total, per_year: perYear, from, to: today, days, years, formula };
}

export function germanDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/** One line per group, then the total and the yield — what the model may repeat. */
export function reportDigest(report: GroupedReport): string {
  const lines = report.groups.map((g) => `${g.name}: ${g.count} Buchungen, ${euro(g.subtotal, report.currency)}`);
  lines.push(`Summe: ${report.count} Buchungen, ${euro(report.total, report.currency)}`);
  if (report.yield) lines.push(report.yield.formula);
  return lines.join("\n");
}
