/**
 * The securities this installation already knows, for reading a scanned
 * paper against them.
 *
 * OCR confuses a handful of characters (0/O/Q/D, 1/I/L, 5/S, 8/B, 2/Z,
 * 6/G) and drops accents ("Telefönica"). A paper almost always concerns a
 * security the depots hold or held — a sale, a payout, another buy — so an
 * identifier that is not known but differs from exactly one known one only
 * in such characters is that one. A global list of every security would
 * make that guess dangerous: with millions of ISINs, a slip lands on a
 * stranger. A first buy finds nothing here and keeps what was read.
 *
 * Known are the identifiers and names in the securities master, the
 * holdings, the depot transactions and the quote provider's symbols.
 */

import { sql } from "drizzle-orm";

import db from "../db/database";
import { isinChecksumValid } from "./isin";
import type { MergeResult } from "./depot-settlement-merge";

export interface KnownSecurity {
  isin: string | null;
  wkn: string | null;
  /** The names it was seen under, best first (provider, master, papers, bank). */
  names: string[];
}

export interface KnownSecurities {
  byIsin: Map<string, KnownSecurity>;
  byWkn: Map<string, KnownSecurity>;
}

/** Characters OCR reads for one another, each mapped to its group. */
const CONFUSED: Record<string, string> = {
  "0": "0", O: "0", Q: "0", D: "0",
  "1": "1", I: "1", L: "1",
  "5": "5", S: "5",
  "8": "8", B: "8",
  "2": "2", Z: "2",
  "6": "6", G: "6",
};

/** At most this many characters may differ for a reading to be snapped. */
const MAX_SLIPS = 3;

/** Whether `read` can be `known` misread: same length, every difference an OCR confusion. */
export function ocrVariantOf(read: string, known: string): boolean {
  if (read.length !== known.length) return false;
  let slips = 0;
  for (let i = 0; i < read.length; i++) {
    const a = read[i]!;
    const b = known[i]!;
    if (a === b) continue;
    const ga = CONFUSED[a];
    if (!ga || ga !== CONFUSED[b]) return false;
    if (++slips > MAX_SLIPS) return false;
  }
  return true;
}

/** The one known identifier `read` can be a misreading of; null when none or several. */
function snap(read: string, known: Iterable<string>): string | null {
  let found: string | null = null;
  for (const k of known) {
    if (!ocrVariantOf(read, k)) continue;
    if (found !== null && found !== k) return null;
    found = k;
  }
  return found;
}

/** A name compared without case, accents and spacing ("Telefönica" = "Telefónica"). */
export function plainName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function knownFromRows(rows: Iterable<{ isin: string | null; wkn: string | null; name: string | null }>): KnownSecurities {
  const byIsin = new Map<string, KnownSecurity>();
  const byWkn = new Map<string, KnownSecurity>();
  for (const r of rows) {
    const isin = r.isin?.trim().toUpperCase() || null;
    const wkn = r.wkn?.trim().toUpperCase() || null;
    const validIsin = isin && isinChecksumValid(isin) ? isin : null;
    const validWkn = wkn && /^[A-Z0-9]{6}$/.test(wkn) ? wkn : null;
    if (!validIsin && !validWkn) continue;
    let entry = (validIsin && byIsin.get(validIsin)) || (validWkn && byWkn.get(validWkn)) || null;
    if (!entry) entry = { isin: validIsin, wkn: validWkn, names: [] };
    entry.isin ??= validIsin;
    entry.wkn ??= validWkn;
    const name = r.name?.trim();
    if (name && !entry.names.includes(name)) entry.names.push(name);
    if (entry.isin) byIsin.set(entry.isin, entry);
    if (entry.wkn) byWkn.set(entry.wkn, entry);
  }
  return { byIsin, byWkn };
}

/** Everything the installation knows, the provider's names first (they are typed, not scanned). */
export async function knownSecurities(): Promise<KnownSecurities> {
  const rows = await db.execute<{ isin: string | null; wkn: string | null; name: string | null }>(sql`
    SELECT isin, wkn, name FROM (
      SELECT isin, wkn, name, 1 AS rank FROM finance_quote_symbol
      UNION ALL SELECT isin, wkn, name, 2 FROM finance_depot_security
      UNION ALL SELECT DISTINCT isin, wkn, name, 3 FROM finance_depot_transaction
      UNION ALL SELECT DISTINCT isin, wkn, name, 4 FROM finance_account_holding
    ) k
    WHERE isin IS NOT NULL OR wkn IS NOT NULL
    ORDER BY rank
  `);
  return knownFromRows(rows.rows);
}

/**
 * The reading with its identifiers snapped to the known security they are
 * a misreading of, and its name taken from that security when the read
 * one is the same name with OCR's slips (or missing). Fields that changed
 * carry `known_from`: what was read.
 */
export function snapToKnown(merge: MergeResult, known: KnownSecurities): MergeResult {
  const values = { ...merge.values };
  const changed = new Map<string, string>();

  if (values.isin && !known.byIsin.has(values.isin)) {
    const hit = snap(values.isin, known.byIsin.keys());
    if (hit) {
      changed.set("isin", values.isin);
      values.isin = hit;
    }
  }
  if (values.wkn && !known.byWkn.has(values.wkn)) {
    const hit = snap(values.wkn, known.byWkn.keys());
    if (hit) {
      changed.set("wkn", values.wkn);
      values.wkn = hit;
    }
  }
  const entry = (values.isin && known.byIsin.get(values.isin)) || (values.wkn && known.byWkn.get(values.wkn)) || null;
  if (entry) {
    if (!values.wkn && entry.wkn) values.wkn = entry.wkn;
    if (values.name) {
      const plain = plainName(values.name);
      // The same name as the best source spells it (the provider's, then
      // the master's): its accents rather than OCR's. Case is left as
      // printed — capitals on a paper are no slip.
      const same = entry.names.find((n) => plainName(n) === plain);
      if (same && same.toLowerCase() !== values.name.toLowerCase()) {
        changed.set("name", values.name);
        values.name = same;
      }
    } else if (entry.names[0]) {
      values.name = entry.names[0];
    }
  }
  if (changed.size === 0 && values.wkn === merge.values.wkn && values.name === merge.values.name) return merge;

  return {
    ...merge,
    values,
    fields: merge.fields.map((f) =>
      changed.has(f.field) ? { ...f, known_from: changed.get(f.field)! } : f,
    ),
    checks: merge.checks.map((c) =>
      c.name === "isin_checksum" && changed.has("isin") && values.isin
        ? { ...c, result: isinChecksumValid(values.isin) ? ("ok" as const) : ("failed" as const), detail: values.isin }
        : c,
    ),
  };
}
