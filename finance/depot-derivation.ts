/**
 * Derive depot transactions from giro/clearing-account bookings
 * (Track AC Phase 2b — #439 / #428).
 *
 * The cheapest path to per-position transactions: many German banks
 * book Wertpapierabrechnungen ("WERTPAPIERABRECHNUNG", "DIVIDENDE",
 * "FONDSANTEILE") on the giro / Verrechnungskonto with ISO BTC
 * `funds_code='SECU'` and an ISIN in the purpose text. We use that to
 * synthesize `finance_depot_transaction` rows with `source='giro-derived'`.
 *
 * Match rules (strict — false positives are worse than misses here):
 *   - Candidate selection (`isSecuritiesCandidate`): when the bank gave us
 *     a real ISO BTC domain in `funds_code` we trust it and require
 *     `SECU`. Only camt.05x statements carry that; MT940 (HKKAZ) puts a
 *     single letter like "R" there and manual imports leave it null, so
 *     for those we fall back to requiring a hard identifier (ISIN or
 *     prefixed WKN) in the purpose / booking text instead.
 *   - Kind:
 *       transaction_code === 'DVCA'   → 'dividend'  (positive net_amount)
 *       transaction_code === 'CHRG'   → skip (custody fee, not a holding tx)
 *       amount < 0                    → 'buy'
 *       amount > 0                    → 'sell'
 *   - ISIN extracted via the ISO 6166 regex from the purpose field.
 *   - WKN extracted via a prefix-anchored "WKN …" pattern. Many German
 *     banks (e.g. MLP) book only WKNs and leave the ISIN field on the
 *     holdings side blank, so we need both identifiers.
 *   - The derived row is attached to a *depot* account on the same
 *     bankcontact whose holdings currently contain the matching ISIN or
 *     WKN. When multiple depots qualify, the one with the most recent
 *     matching holding wins.
 *   - When the purpose text has neither an ISIN nor a WKN-prefixed code
 *     (e.g. "APPLE INC." with no identifier at all), fall back to matching
 *     the holding's own display name against the purpose text. Every
 *     significant word of the name (legal-form suffixes like "INC"/"AG"
 *     stripped) must appear in the purpose, and the match must be
 *     unambiguous — exactly one qualifying security across the
 *     bankcontact's depots — or we skip.
 *   - Unmatched SECU bookings are skipped silently (counted, not errored —
 *     re-running after the next sync may match).
 *
 * Idempotency: `dedupe_hash = "giro:<linked_transaction_id>"` and the
 * partial unique index `(account_id, dedupe_hash) WHERE dedupe_hash IS
 * NOT NULL` makes re-runs no-ops.
 */

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountHolding,
  financeDepotTransaction,
  financeTransaction,
} from "../db/schema";

console.log("[boot] finance/depot-derivation.ts: all imports resolved");

/** ISO 6166 ISIN: two letters + nine alphanumerics + one check digit. */
const ISIN_RE = /\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/;

/** Extract the first ISIN appearing in a free-text field, or null. */
export function extractIsin(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(ISIN_RE);
  return m ? m[0] : null;
}

/**
 * German Wertpapierkennnummer: always 6 alphanumeric characters. The
 * shape alone is too generic (matches dates, amounts, fragments of
 * IBANs), so we require an explicit prefix to avoid false positives.
 * Banks spell that prefix several ways — "WKN 930921", "WKN: 930921",
 * "WKN/ISIN 930921/LU…", and (e.g. comdirect/Sparkasse Wertpapier-
 * abrechnungen) "WPKNR: 865985" or "WP-KENNNR 865985".
 */
const WKN_RE = /\b(?:WKN|WPKNR|WPK|WP-?KENN(?:NR|NUMMER)?)[.:\s/]+([A-Z0-9]{6})\b/i;

/** Extract the first prefixed WKN appearing in a free-text field, or null. */
export function extractWkn(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(WKN_RE);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Legal-form / share-class suffixes stripped before comparing a holding's
 * display name against free text — they carry no identifying signal and
 * would otherwise dilute the word match below (e.g. "AG" or "INC" showing
 * up in unrelated purposes).
 */
const NAME_SUFFIX_WORDS = new Set([
  "INC", "INCORPORATED", "CORP", "CORPORATION", "AG", "SE", "LTD", "LIMITED",
  "PLC", "CO", "COMPANY", "KGAA", "NV", "SA", "SPA", "GMBH", "HOLDING",
  "HOLDINGS", "GROUP", "CLASS", "ORD", "REG", "SHS", "COM",
]);

function nameWords(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0);
}

function coreNameWords(name: string): string[] {
  return nameWords(name).filter((w) => !NAME_SUFFIX_WORDS.has(w));
}

interface HoldingMatch {
  account_id: number;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  currency: string | null;
}

/**
 * Fallback for bookings whose purpose text carries neither ISIN nor a
 * WKN-prefixed code (e.g. "APPLE INC." with nothing else) — match by the
 * holding's own display name instead. Deliberately conservative: every
 * significant word of the holding's name must appear in the purpose text,
 * and the match must be unambiguous (exactly one qualifying security) or
 * we skip, per the "false positives are worse than misses" rule above.
 */
async function matchHoldingByName(
  bankcontactId: number,
  purpose: string | null | undefined,
): Promise<HoldingMatch | undefined> {
  if (!purpose) return undefined;
  const purposeWords = new Set(nameWords(purpose));
  if (purposeWords.size === 0) return undefined;

  const holdings = await db
    .select({
      account_id: financeAccountHolding.account_id,
      isin: financeAccountHolding.isin,
      wkn: financeAccountHolding.wkn,
      name: financeAccountHolding.name,
      currency: financeAccountHolding.currency,
    })
    .from(financeAccountHolding)
    .innerJoin(
      financeAccount,
      eq(financeAccount.id, financeAccountHolding.account_id),
    )
    .where(eq(financeAccount.bankcontact_id, bankcontactId))
    .orderBy(desc(financeAccountHolding.as_of));

  // Most-recent snapshot per distinct security (account + isin/wkn/name),
  // mirroring the "most recent as_of wins" rule used for identifier matches.
  const latestBySecurity = new Map<string, HoldingMatch>();
  for (const h of holdings) {
    const key = `${h.account_id}:${h.isin ?? h.wkn ?? h.name}`;
    if (!latestBySecurity.has(key)) latestBySecurity.set(key, h);
  }

  const matches = [...latestBySecurity.values()].filter((h) => {
    const core = coreNameWords(h.name ?? "");
    return core.length > 0 && core.every((w) => purposeWords.has(w));
  });

  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * ISO 20022 BTC domain codes. Used to decide whether `funds_code` actually
 * carries usable Bank-Transaction-Code information — see
 * `hasUsableBtcDomain` below.
 */
const BTC_DOMAIN_CODES: ReadonlySet<string> = new Set([
  "ACMT", "CAMT", "CMDT", "DERV", "FORX", "LDAS",
  "PMET", "PMNT", "SECU", "TRAD", "XTND",
]);

/**
 * True when `funds_code` holds a real ISO BTC domain and we can therefore
 * trust it as the authoritative securities/non-securities signal.
 *
 * Only the CAMT (camt.05x) path ever fills this in: lib-fints sets
 * `fundsCode = bkTxCd.domainCode || creditDebitInd`. The MT940 path
 * (HKKAZ, what most German banks still deliver) parses subfield 4 of the
 * `:61:` line instead — a *single letter* such as "R" — and the manual
 * import path leaves it null. In those cases the field says nothing about
 * whether a booking is a Wertpapierabrechnung, so we must not gate on it.
 */
export function hasUsableBtcDomain(
  fundsCode: string | null | undefined,
): boolean {
  if (!fundsCode) return false;
  return BTC_DOMAIN_CODES.has(fundsCode.trim().toUpperCase());
}

/**
 * Decide whether a giro booking is worth examining as a possible
 * Wertpapierabrechnung.
 *
 * Two admissible routes, mirroring what the source data can tell us:
 *
 *   1. The bank gave us a real BTC domain → trust it completely. `SECU`
 *      qualifies, every other domain (PMNT, CAMT, …) is excluded. This
 *      keeps the original strict behaviour for camt-sourced bookings, so
 *      a rent payment that happens to quote an ISIN stays excluded.
 *   2. No usable BTC domain (MT940 single-letter code, or null) → fall
 *      back to the text, and require a hard security identifier: an ISIN
 *      or a prefixed WKN in the purpose or booking text. A booking that
 *      names neither is never considered on this route.
 *
 * Route 2 alone is not what creates a depot transaction — the caller
 * still has to match the extracted identifier against a holding that
 * actually exists on one of the bankcontact's depots, so a stray
 * ISIN-shaped token cannot conjure a position out of nothing.
 */
export function isSecuritiesCandidate(tx: {
  funds_code: string | null;
  purpose: string | null;
  entry_text?: string | null;
}): boolean {
  if (hasUsableBtcDomain(tx.funds_code)) {
    return tx.funds_code!.trim().toUpperCase() === "SECU";
  }
  const text = `${tx.purpose ?? ""}\n${tx.entry_text ?? ""}`;
  return extractIsin(text) !== null || extractWkn(text) !== null;
}

export type DerivedKind = "buy" | "sell" | "dividend";

/**
 * Classify a SECU-flagged giro transaction. Returns null when the row
 * should be skipped (e.g. custody fees or zero-amount oddities).
 */
export function classifySecuTransaction(tx: {
  amount: string;
  transaction_code: string | null;
}): DerivedKind | null {
  const subFamily = tx.transaction_code?.toUpperCase() ?? "";
  if (subFamily === "CHRG") return null;
  if (subFamily === "DVCA") return "dividend";
  const n = Number(tx.amount);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? "buy" : "sell";
}

export interface DerivationStats {
  /** Newly inserted rows. */
  derived: number;
  /** Securities bookings considered but skipped (no holding match, fee, …). */
  skipped: number;
  /** Bookings already covered by a prior derivation (dedupe hit). */
  duplicates: number;
  /** Soft errors (per-tx insert failures). */
  errors: string[];
  /**
   * Bookings that passed `isSecuritiesCandidate` and were actually
   * examined. Zero here means nothing on this bankcontact looked like a
   * Wertpapierabrechnung at all — a different problem from "examined but
   * no holding matched", which the counters below separate out.
   */
  candidates: number;
  /** Skipped by `classifySecuTransaction` (custody fee, zero amount). */
  skipped_not_classified: number;
  /** No ISIN/WKN extractable and the name fallback found nothing. */
  skipped_no_identifier: number;
  /** Identifier found, but no holding on this bankcontact carries it. */
  skipped_no_holding: number;
}

/**
 * Walk securities-looking transactions on every account of the given
 * bankcontact and write `source='giro-derived'` rows into
 * finance_depot_transaction for the ones that match a known holding.
 */
export async function deriveDepotTransactionsForBankcontact(
  bankcontactId: number,
): Promise<DerivationStats> {
  const stats: DerivationStats = {
    derived: 0,
    skipped: 0,
    duplicates: 0,
    errors: [],
    candidates: 0,
    skipped_not_classified: 0,
    skipped_no_identifier: 0,
    skipped_no_holding: 0,
  };

  // All accounts on this bankcontact — we look at giro/clearing txs and
  // attach derived rows back to a depot account on the same bankcontact.
  const accounts = await db
    .select({ id: financeAccount.id })
    .from(financeAccount)
    .where(eq(financeAccount.bankcontact_id, bankcontactId));
  if (accounts.length === 0) return stats;
  const accountIds = accounts.map((a) => a.id);

  const txs = await db
    .select({
      id: financeTransaction.id,
      account_id: financeTransaction.account_id,
      booking_date: financeTransaction.booking_date,
      value_date: financeTransaction.value_date,
      amount: financeTransaction.amount,
      currency_code: financeTransaction.currency_code,
      purpose: financeTransaction.purpose,
      counterparty: financeTransaction.counterparty,
      funds_code: financeTransaction.funds_code,
      entry_text: financeTransaction.entry_text,
      transaction_type: financeTransaction.transaction_type,
      transaction_code: financeTransaction.transaction_code,
    })
    .from(financeTransaction)
    .where(
      and(
        inArray(financeTransaction.account_id, accountIds),
        // Cheap SQL pre-filter; `isSecuritiesCandidate` below makes the
        // authoritative call. Either the bank flagged the booking SECU,
        // or the text mentions something identifier-shaped that is worth
        // running the precise regexes over.
        or(
          eq(financeTransaction.funds_code, "SECU"),
          sql`(
            coalesce(${financeTransaction.purpose}, '') || ' ' ||
            coalesce(${financeTransaction.entry_text}, '') || ' ' ||
            coalesce(${financeTransaction.counterparty}, '')
          ) ~* '([A-Z]{2}[A-Z0-9]{9}[0-9])|(WKN|WPKNR|WPK|WP-?KENN)'`,
        ),
      ),
    );

  for (const tx of txs) {
    if (!isSecuritiesCandidate(tx)) continue;
    stats.candidates++;

    const kind = classifySecuTransaction(tx);
    if (kind === null) {
      stats.skipped++;
      stats.skipped_not_classified++;
      continue;
    }

    const isin =
      extractIsin(tx.purpose) ??
      extractIsin(tx.entry_text) ??
      extractIsin(tx.counterparty);
    const wkn =
      extractWkn(tx.purpose) ??
      extractWkn(tx.entry_text) ??
      extractWkn(tx.counterparty);

    let holding: HoldingMatch | undefined;

    if (isin || wkn) {
      // Find a depot account on the same bankcontact whose holdings
      // include this ISIN or WKN. Pick the most recent snapshot to break
      // ties. We accept either identifier because some banks only fill in
      // WKN on the holdings side (or only ISIN on the booking side).
      const idMatches = [];
      if (isin) idMatches.push(eq(financeAccountHolding.isin, isin));
      if (wkn) idMatches.push(eq(financeAccountHolding.wkn, wkn));

      [holding] = await db
        .select({
          account_id: financeAccountHolding.account_id,
          isin: financeAccountHolding.isin,
          wkn: financeAccountHolding.wkn,
          name: financeAccountHolding.name,
          currency: financeAccountHolding.currency,
        })
        .from(financeAccountHolding)
        .innerJoin(
          financeAccount,
          eq(financeAccount.id, financeAccountHolding.account_id),
        )
        .where(
          and(
            eq(financeAccount.bankcontact_id, bankcontactId),
            or(...idMatches),
          ),
        )
        .orderBy(desc(financeAccountHolding.as_of))
        .limit(1);
    } else {
      // No ISIN and no WKN-prefixed code in the text (e.g. "APPLE INC."
      // with nothing else) — fall back to matching the holding's own
      // display name against the purpose text.
      holding = await matchHoldingByName(bankcontactId, tx.purpose);
    }

    if (!holding) {
      stats.skipped++;
      if (isin || wkn) stats.skipped_no_holding++;
      else stats.skipped_no_identifier++;
      continue;
    }

    // Build the row. Net amount on the giro side is the cash flow with
    // its original sign; gross_amount is the absolute value (the giro
    // booking already nets fees, so we don't try to split them out).
    const netSigned = Number(tx.amount);
    const gross = Math.abs(netSigned).toFixed(2);
    const net = netSigned.toFixed(2);
    const dedupeHash = `giro:${tx.id}`;

    // Prefer the value we actually extracted from the booking; fall
    // back to whatever the holding carries so the row always has the
    // best identifier we know about (UI filters per-position by isin
    // OR wkn, whichever is non-null on the holding).
    const rowIsin = isin ?? holding.isin;
    const rowWkn = wkn ?? holding.wkn;

    try {
      const inserted = await db
        .insert(financeDepotTransaction)
        .values({
          account_id: holding.account_id,
          isin: rowIsin,
          wkn: rowWkn,
          name: holding.name,
          kind,
          executed_at: (tx.value_date ?? tx.booking_date).slice(0, 10),
          amount: null, // shares not known from a giro booking
          price: null,
          gross_amount: gross,
          fees: null,
          tax: null,
          net_amount: net,
          currency: tx.currency_code ?? holding.currency,
          source: "giro-derived",
          linked_transaction_id: tx.id,
          dedupe_hash: dedupeHash,
        })
        .onConflictDoNothing({
          target: [
            financeDepotTransaction.account_id,
            financeDepotTransaction.dedupe_hash,
          ],
          // Index is partial (WHERE dedupe_hash IS NOT NULL) so Postgres
          // needs the matching predicate in the ON CONFLICT clause.
          where: sql`${financeDepotTransaction.dedupe_hash} IS NOT NULL`,
        })
        .returning({ id: financeDepotTransaction.id });

      if (inserted.length > 0) {
        stats.derived++;
      } else {
        stats.duplicates++;
      }
    } catch (err) {
      stats.errors.push(
        `tx ${tx.id} (${rowIsin ?? rowWkn}): derivation insert failed: ` +
          ((err as Error).message ?? String(err)),
      );
    }
  }

  return stats;
}
