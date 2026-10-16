/**
 * Transaction reports in groups (#1533): preview, save, re-run and PDF.
 *
 * A group is a list of booking ids, or one user tag — a rule, so a saved
 * report re-run later picks up the bookings tagged since. Bookings named
 * beyond the groups (`transaction_ids`) land in "Sonstige". Only bookings on
 * accounts the caller may read are accepted; one that is not readable is
 * refused, never silently dropped, so a subtotal never hides a gap.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { financeGroupedReport, financeTag, financeTagTransaction, financeTransaction } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { readableFinanceAccountIds } from "./account-acl";
import {
  buildGroupedReport,
  ReportInputError,
  type GroupedReport,
  type ReportBooking,
  type ReportGroupInput,
  type YieldInput,
} from "./grouped-report";
import { createGroupedReportPdf } from "./pdf-report";

const MAX_BOOKINGS = 5000;
const MAX_GROUPS = 20;

export interface ReportGroupDefinition {
  name: string;
  /** Explicit bookings … */
  transaction_ids?: number[];
  /** … or one user tag: every readable booking carrying it, at each run. */
  tag?: string;
}

export interface GroupedReportDefinition {
  title: string;
  groups: ReportGroupDefinition[];
  /** Bookings the report covers beyond the groups; they land in "Sonstige". */
  transaction_ids?: number[];
  yield?: YieldInput | null;
}

export interface ReportGroupDTO {
  name: string;
  count: number;
  /** Cents. */
  subtotal: number;
  transaction_ids: number[];
}

export interface ReportYieldDTO {
  investment: number;
  income: number;
  costs: number;
  net: number;
  total: number;
  per_year: number;
  from: string;
  to: string;
  days: number;
  formula: string;
}

export interface GroupedReportDTO {
  id: number | null;
  title: string;
  currency: string;
  groups: ReportGroupDTO[];
  total: number;
  count: number;
  yield: ReportYieldDTO | null;
  generated_on: string;
}

function caller() {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "module.finance");
  requirePermission(auth, "finance.view");
  return auth;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function cleanIds(ids: unknown): number[] {
  return Array.isArray(ids)
    ? [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
}

/** Bookings by id, refusing any the caller may not read. */
async function loadBookings(
  auth: { userID: string; permissions: string[] },
  ids: number[],
): Promise<Map<number, ReportBooking>> {
  const readable = await readableFinanceAccountIds(auth);
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: financeTransaction.id,
      account_id: financeTransaction.account_id,
      booking_date: financeTransaction.booking_date,
      counterparty: financeTransaction.counterparty,
      purpose: financeTransaction.purpose,
      amount: financeTransaction.amount,
      currency_code: financeTransaction.currency_code,
    })
    .from(financeTransaction)
    .where(inArray(financeTransaction.id, ids));
  const visible = rows.filter((r) => readable === null || readable.includes(r.account_id));
  const found = new Set(visible.map((r) => r.id));
  const refused = ids.filter((id) => !found.has(id));
  if (refused.length) {
    throw APIError.invalidArgument(`bookings not found or not readable: ${refused.slice(0, 10).join(", ")}`);
  }
  return new Map(visible.map((r) => [r.id, {
    id: r.id,
    booking_date: r.booking_date.slice(0, 10),
    counterparty: r.counterparty,
    purpose: r.purpose,
    amount: r.amount,
    currency_code: r.currency_code,
  }]));
}

/** Readable bookings carrying a user tag. */
async function idsWithTag(auth: { userID: string; permissions: string[] }, tag: string): Promise<number[]> {
  const readable = await readableFinanceAccountIds(auth);
  if (readable !== null && readable.length === 0) return [];
  const rows = await db
    .select({ id: financeTransaction.id })
    .from(financeTagTransaction)
    .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
    .innerJoin(financeTransaction, eq(financeTransaction.id, financeTagTransaction.transaction_id))
    .where(and(
      eq(financeTag.name, tag),
      eq(financeTag.source, "user"),
      ...(readable === null ? [] : [inArray(financeTransaction.account_id, readable)]),
    ));
  return rows.map((r) => Number(r.id));
}

function validate(def: GroupedReportDefinition): void {
  if (!def.title?.trim()) throw APIError.invalidArgument("title must not be empty");
  if (!Array.isArray(def.groups) || def.groups.length === 0) throw APIError.invalidArgument("at least one group is needed");
  if (def.groups.length > MAX_GROUPS) throw APIError.invalidArgument(`at most ${MAX_GROUPS} groups`);
  for (const g of def.groups) {
    const hasIds = cleanIds(g.transaction_ids).length > 0;
    const hasTag = !!g.tag?.trim();
    if (hasIds === hasTag) throw APIError.invalidArgument(`group "${g.name}" needs either transaction_ids or a tag`);
  }
}

/** Resolves the definition against the bookings as they are now. */
export async function runReport(
  auth: { userID: string; permissions: string[] },
  def: GroupedReportDefinition,
  on = today(),
): Promise<GroupedReport> {
  validate(def);
  // Explicit ids first; a tag group takes what no earlier group claimed, so
  // a booking tagged later cannot make a saved report fail.
  const claimed = new Set<number>();
  const explicit = def.groups.flatMap((g) => cleanIds(g.transaction_ids));
  explicit.forEach((id) => claimed.add(id));
  const groups: ReportGroupInput[] = [];
  for (const g of def.groups) {
    if (g.tag?.trim()) {
      const ids = (await idsWithTag(auth, g.tag.trim())).filter((id) => !claimed.has(id));
      ids.forEach((id) => claimed.add(id));
      groups.push({ name: g.name, transaction_ids: ids });
    } else {
      groups.push({ name: g.name, transaction_ids: cleanIds(g.transaction_ids) });
    }
  }
  const all = cleanIds(def.transaction_ids);
  const ids = [...new Set([...groups.flatMap((g) => g.transaction_ids), ...all])];
  if (ids.length > MAX_BOOKINGS) throw APIError.invalidArgument(`at most ${MAX_BOOKINGS} bookings in one report`);
  const bookings = await loadBookings(auth, ids);
  try {
    return buildGroupedReport({
      title: def.title,
      groups,
      bookings: [...bookings.values()],
      all,
      yield: def.yield ?? null,
      today: on,
    });
  } catch (err) {
    if (err instanceof ReportInputError) throw APIError.invalidArgument(err.message);
    throw err;
  }
}

function toDTO(report: GroupedReport, id: number | null): GroupedReportDTO {
  return {
    id,
    title: report.title,
    currency: report.currency,
    groups: report.groups.map((g) => ({ name: g.name, count: g.count, subtotal: g.subtotal, transaction_ids: g.bookings.map((b) => b.id) })),
    total: report.total,
    count: report.count,
    yield: report.yield
      ? {
          investment: report.yield.investment,
          income: report.yield.income,
          costs: report.yield.costs,
          net: report.yield.net,
          total: report.yield.total,
          per_year: report.yield.per_year,
          from: report.yield.from,
          to: report.yield.to,
          days: report.yield.days,
          formula: report.yield.formula,
        }
      : null,
    generated_on: report.generated_on,
  };
}

/** Computes a report without keeping it — what the assistant's proposal card shows. */
export const previewGroupedReport = api(
  { expose: true, method: "POST", path: "/finance/reports/grouped/preview", auth: true },
  async (def: GroupedReportDefinition): Promise<GroupedReportDTO> => {
    const auth = caller();
    return toDTO(await runReport(auth, def), null);
  },
);

/** Keeps the definition, so the report can be run again with the bookings of then. */
export const createGroupedReport = api(
  { expose: true, method: "POST", path: "/finance/reports/grouped", auth: true },
  async (def: GroupedReportDefinition): Promise<GroupedReportDTO> => {
    const auth = caller();
    const report = await runReport(auth, def);
    const [row] = await db
      .insert(financeGroupedReport)
      .values({
        user_id: Number(auth.userID),
        title: report.title,
        definition: {
          groups: def.groups.map((g) => (g.tag?.trim()
            ? { name: g.name, tag: g.tag.trim() }
            : { name: g.name, transaction_ids: cleanIds(g.transaction_ids) })),
          transaction_ids: cleanIds(def.transaction_ids),
          yield: def.yield ?? null,
        },
      })
      .returning({ id: financeGroupedReport.id });
    return toDTO(report, row.id);
  },
);

async function ownReport(id: number, userId: number) {
  const [row] = await db
    .select()
    .from(financeGroupedReport)
    .where(and(eq(financeGroupedReport.id, id), eq(financeGroupedReport.user_id, userId)))
    .limit(1);
  if (!row) throw APIError.notFound("report not found");
  return row;
}

export interface GroupedReportSummary {
  id: number;
  title: string;
  created_at: string;
}

export const listGroupedReports = api(
  { expose: true, method: "GET", path: "/finance/reports/grouped", auth: true },
  async (): Promise<{ items: GroupedReportSummary[] }> => {
    const auth = caller();
    const rows = await db
      .select({ id: financeGroupedReport.id, title: financeGroupedReport.title, created_at: financeGroupedReport.created_at })
      .from(financeGroupedReport)
      .where(eq(financeGroupedReport.user_id, Number(auth.userID)))
      .orderBy(desc(financeGroupedReport.created_at))
      .limit(200);
    return { items: rows };
  },
);

/** Runs a kept report again, on the bookings as they are now. */
export const getGroupedReport = api(
  { expose: true, method: "GET", path: "/finance/reports/grouped/:id", auth: true },
  async ({ id }: { id: number }): Promise<GroupedReportDTO> => {
    const auth = caller();
    const row = await ownReport(id, Number(auth.userID));
    return toDTO(await runReport(auth, { title: row.title, ...row.definition }), row.id);
  },
);

export const deleteGroupedReport = api(
  { expose: true, method: "DELETE", path: "/finance/reports/grouped/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const auth = caller();
    await ownReport(id, Number(auth.userID));
    await db.delete(financeGroupedReport).where(eq(financeGroupedReport.id, id));
    return { deleted: true };
  },
);

function slug(title: string): string {
  return title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) || "bericht";
}

/** The kept report as PDF, computed now. */
export const groupedReportPdf = api.raw(
  { expose: true, method: "GET", path: "/finance/reports/grouped/:id/pdf", auth: true },
  async (req, res) => {
    let report: GroupedReport;
    try {
      const auth = caller();
      const id = Number((req.url ?? "").split("?")[0].split("/").at(-2));
      if (!Number.isInteger(id)) throw APIError.invalidArgument("bad report id");
      const row = await ownReport(id, Number(auth.userID));
      report = await runReport(auth, { title: row.title, ...row.definition });
    } catch (err) {
      const status = err instanceof APIError
        ? ({ not_found: 404, unauthenticated: 401, permission_denied: 403, invalid_argument: 400 } as Record<string, number>)[err.code] ?? 500
        : 500;
      res.statusCode = status;
      res.end(err instanceof Error ? err.message : "error");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${slug(report.title)}-${report.generated_on}.pdf"`);
    const pdf = createGroupedReportPdf(report);
    pdf.pipe(res);
    pdf.end();
  },
);
