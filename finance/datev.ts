import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { financeAccountAccess, financeDatevMapping, financeTag, financeTagTransaction, financeTransaction } from "../db/schema";
import { requirePermission } from "../user/auth-handler";

function currentUser() {
  const auth = getAuthData()!;
  requirePermission(auth, "finance.view");
  return auth;
}

export const listDatevMappings = api(
  { expose: true, method: "GET", path: "/finance/datev/mappings", auth: true },
  async () => {
    const auth = currentUser();
    return { items: await db.select().from(financeDatevMapping).where(eq(financeDatevMapping.user_id, Number(auth.userID))) };
  },
);

export const saveDatevMapping = api(
  { expose: true, method: "POST", path: "/finance/datev/mappings", auth: true },
  async (p: { tag_name: string; konto_soll: string; konto_haben: string; bu_schluessel?: string | null }) => {
    const auth = currentUser();
    const tag = p.tag_name?.trim();
    if (!tag || !/^\d{1,9}$/.test(p.konto_soll) || !/^\d{1,9}$/.test(p.konto_haben)) {
      throw APIError.invalidArgument("tag_name and numeric DATEV accounts required");
    }
    const [row] = await db.insert(financeDatevMapping).values({
      user_id: Number(auth.userID), tag_name: tag, konto_soll: p.konto_soll, konto_haben: p.konto_haben,
      bu_schluessel: p.bu_schluessel?.trim() || null,
    }).onConflictDoUpdate({
      target: [financeDatevMapping.user_id, financeDatevMapping.tag_name],
      set: { konto_soll: p.konto_soll, konto_haben: p.konto_haben, bu_schluessel: p.bu_schluessel?.trim() || null },
    }).returning();
    return row;
  },
);

const quote = (value: string) => `"${value.replace(/[\r\n]+/g, " ").replace(/"/g, '""')}"`;
const datevDate = (value: string) => value.slice(8, 10) + value.slice(5, 7);

export const exportTransactionsDatev = api.raw(
  { expose: true, method: "GET", path: "/finance/datev/export", auth: true },
  async (req, res) => {
    const auth = currentUser();
    const url = new URL(req.url ?? "/", "http://localhost");
    const ids = (url.searchParams.get("ids") ?? "").split(",").map(Number).filter(Number.isInteger);
    const berater = url.searchParams.get("berater") ?? "";
    const mandant = url.searchParams.get("mandant") ?? "";
    if (!ids.length || !/^\d{1,7}$/.test(berater) || !/^\d{1,5}$/.test(mandant)) {
      res.statusCode = 400; res.end("ids, berater and mandant required"); return;
    }
    let allowedAccountIds: number[] | null = null;
    if (!auth.permissions.includes("finance.admin")) {
      allowedAccountIds = (await db.select({ id: financeAccountAccess.account_id }).from(financeAccountAccess).where(eq(financeAccountAccess.user_id, Number(auth.userID)))).map(row => row.id);
    }
    const conditions = [inArray(financeTransaction.id, ids)];
    if (allowedAccountIds !== null) conditions.push(inArray(financeTransaction.account_id, allowedAccountIds));
    const rows = await db.select().from(financeTransaction).where(and(...conditions)).orderBy(financeTransaction.booking_date);
    const mappings = await db.select().from(financeDatevMapping).where(eq(financeDatevMapping.user_id, Number(auth.userID)));
    const mappingByTag = new Map(mappings.map(mapping => [mapping.tag_name, mapping]));
    const joins = rows.length ? await db.select({ transaction_id: financeTagTransaction.transaction_id, name: financeTag.name })
      .from(financeTagTransaction).innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(inArray(financeTagTransaction.transaction_id, rows.map(row => row.id))) : [];
    const tags = new Map<number, string[]>();
    for (const join of joins) tags.set(join.transaction_id, [...(tags.get(join.transaction_id) ?? []), join.name]);
    const missing = rows.filter(row => !(tags.get(row.id) ?? []).some(tag => mappingByTag.has(tag)));
    if (missing.length) { res.statusCode = 422; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: "missing_mapping", transaction_ids: missing.map(row => row.id) })); return; }

    const now = new Date();
    const stamp = now.toISOString().replace(/\D/g, "").slice(0, 17);
    const dates = rows.map(row => row.booking_date.slice(0, 10));
    const from = dates[0]!.replace(/-/g, ""); const to = dates[dates.length - 1]!.replace(/-/g, "");
    const header = `${quote("EXTF")};700;21;${quote("Buchungsstapel")};13;${stamp};;${quote("RE")};${quote("")};${quote("")};${berater};${mandant};${from};4;${from};${to};${quote("fk-encore Basket")};${quote("WD")};1;0;0;${quote("EUR")};;;;;${quote("03")};;;${quote("")};${quote("")}`;
    const columns = "Umsatz (ohne Soll/Haben-Kz);Soll/Haben-Kennzeichen;WKZ Umsatz;Kurs;Basis-Umsatz;WKZ Basis-Umsatz;Konto;Gegenkonto (ohne BU-Schlüssel);BU-Schlüssel;Belegdatum;Belegfeld 1;Belegfeld 2;Skonto;Buchungstext";
    const lines = rows.map(row => {
      const mapping = (tags.get(row.id) ?? []).map(tag => mappingByTag.get(tag)).find(Boolean)!;
      const negative = Number(row.amount) < 0;
      return [Math.abs(Number(row.amount)).toFixed(2).replace(".", ","), quote(negative ? "H" : "S"), quote(row.currency_code), "", "", "", negative ? mapping.konto_haben : mapping.konto_soll, negative ? mapping.konto_soll : mapping.konto_haben, mapping.bu_schluessel ?? "", datevDate(row.booking_date), String(row.id), "", "", quote((row.counterparty ?? row.purpose ?? "Buchung").slice(0, 60))].join(";");
    });
    res.statusCode = 200; res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="EXTF_Buchungsstapel_${from}_${to}.csv"`);
    res.end("\uFEFF" + [header, columns, ...lines].join("\r\n") + "\r\n");
  },
);
