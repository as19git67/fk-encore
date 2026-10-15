/**
 * One security, one identity — whichever identifier a row carries.
 *
 * Banks and papers name a security differently: the FinTS holdings may
 * carry only the WKN, a depot statement the ISIN, a settlement both.
 * Positions are keyed by COALESCE(isin, wkn, name), so the same security
 * fell apart into two positions — one under the ISIN, one under the WKN —
 * and the holdings reconciliation saw it vanish and reappear between
 * snapshots of different sources.
 *
 * The pairs (ISIN, WKN) every row that carries both has taught are
 * collected here (the depots' securities master, holdings, transactions,
 * resolved quote symbols), and a row with only one of them is completed
 * with the other. A WKN known with two different ISINs is left alone:
 * guessing would merge two securities.
 */

import { sql } from "drizzle-orm";

import db from "../db/database";
import { isinChecksumValid, repairIsin } from "./isin";

export interface SecurityIdentity {
  /** The row with the identifier it lacks filled in, when known. */
  complete<T extends { isin: string | null; wkn: string | null }>(row: T): T;
  /** COALESCE(isin, wkn, name) after completing the row. */
  key(row: { isin: string | null; wkn: string | null; name: string | null }): string;
  /** Every WKN known for the ISIN (for a query by key). */
  wknsOf(isin: string): string[];
}

/** Builds the identity from (isin, wkn) pairs; exported for tests. */
export function identityFromPairs(pairs: Iterable<{ isin: string | null; wkn: string | null }>): SecurityIdentity {
  const isinsByWkn = new Map<string, Set<string>>();
  const wknsByIsin = new Map<string, Set<string>>();
  for (const p of pairs) {
    const isin = p.isin?.trim().toUpperCase();
    const wkn = p.wkn?.trim().toUpperCase();
    if (!isin || !wkn || !isinChecksumValid(isin)) continue;
    (isinsByWkn.get(wkn) ?? isinsByWkn.set(wkn, new Set()).get(wkn)!).add(isin);
    (wknsByIsin.get(isin) ?? wknsByIsin.set(isin, new Set()).get(isin)!).add(wkn);
  }
  const isinOf = (wkn: string): string | null => {
    const set = isinsByWkn.get(wkn.trim().toUpperCase());
    return set && set.size === 1 ? [...set][0]! : null;
  };
  const wknOf = (isin: string): string | null => {
    const set = wknsByIsin.get(isin.trim().toUpperCase());
    if (!set || set.size !== 1) return null;
    const wkn = [...set][0]!;
    // Only a WKN that names this ISIN alone.
    return isinOf(wkn) === isin.trim().toUpperCase() ? wkn : null;
  };
  const complete = <T extends { isin: string | null; wkn: string | null }>(input: T): T => {
    // An ISIN stored as OCR read it ("GBOOB…" for "GB00B…"), from before
    // the readings repaired it: the repair that holds its check digit.
    let row = input;
    if (row.isin && !isinChecksumValid(row.isin)) {
      const repaired = repairIsin(row.isin);
      if (repaired !== row.isin && isinChecksumValid(repaired)) row = { ...row, isin: repaired };
    }
    if (row.isin && row.wkn) return row;
    if (!row.isin && row.wkn) {
      const isin = isinOf(row.wkn);
      return isin ? { ...row, isin } : row;
    }
    if (row.isin && !row.wkn) {
      const wkn = wknOf(row.isin);
      return wkn ? { ...row, wkn } : row;
    }
    return row;
  };
  return {
    complete,
    key(row) {
      const r = complete(row);
      return r.isin || r.wkn || r.name || "";
    },
    wknsOf(isin) {
      return [...(wknsByIsin.get(isin.trim().toUpperCase()) ?? [])].filter((w) => isinOf(w) === isin.trim().toUpperCase());
    },
  };
}

/** The pairs every table that carries both identifiers knows. */
export async function securityIdentity(): Promise<SecurityIdentity> {
  const rows = await db.execute<{ isin: string; wkn: string }>(sql`
    SELECT DISTINCT isin, wkn FROM finance_depot_security WHERE isin IS NOT NULL AND wkn IS NOT NULL
    UNION
    SELECT DISTINCT isin, wkn FROM finance_account_holding WHERE isin IS NOT NULL AND wkn IS NOT NULL
    UNION
    SELECT DISTINCT isin, wkn FROM finance_depot_transaction WHERE isin IS NOT NULL AND wkn IS NOT NULL
    UNION
    SELECT DISTINCT isin, wkn FROM finance_quote_symbol WHERE isin IS NOT NULL AND wkn IS NOT NULL
  `);
  return identityFromPairs(rows.rows);
}

/**
 * Rows of one depot and day that name the same security under different
 * identifiers (the bank's WKN row, a statement's ISIN row) are one
 * holding: one row stays, the bank's when there is one. Rows must be
 * completed already.
 */
export function dedupeSnapshotRows<T extends { account_id: number; as_of: string; isin: string | null; wkn: string | null; name: string | null; source?: string | null }>(
  rows: T[],
): T[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const id = `${r.account_id}|${String(r.as_of).slice(0, 10)}|${r.isin || r.wkn || r.name || ""}`;
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(r);
  }
  const out: T[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]!);
      continue;
    }
    out.push(list.find((r) => (r.source ?? "bank") === "bank") ?? list[0]!);
  }
  return out;
}
