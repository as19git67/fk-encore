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
 *   - Caller filters to `funds_code === 'SECU'` only.
 *   - Kind:
 *       transaction_code === 'DVCA'   → 'dividend'  (positive net_amount)
 *       transaction_code === 'CHRG'   → skip (custody fee, not a holding tx)
 *       amount < 0                    → 'buy'
 *       amount > 0                    → 'sell'
 *   - ISIN extracted via the ISO 6166 regex from the purpose field.
 *   - The derived row is attached to a *depot* account on the same
 *     bankcontact whose holdings currently contain that ISIN. When
 *     multiple depots qualify, the one with the most recent matching
 *     holding wins. Unmatched SECU bookings are skipped silently
 *     (counted, not errored — re-running after the next sync may match).
 *
 * Idempotency: `dedupe_hash = "giro:<linked_transaction_id>"` and the
 * partial unique index `(account_id, dedupe_hash) WHERE dedupe_hash IS
 * NOT NULL` makes re-runs no-ops.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";

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
  /** SECU bookings considered but skipped (no ISIN match, custody fee, …). */
  skipped: number;
  /** Bookings already covered by a prior derivation (dedupe hit). */
  duplicates: number;
  /** Soft errors (per-tx insert failures). */
  errors: string[];
}

/**
 * Walk SECU-flagged transactions on every account of the given
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
      transaction_type: financeTransaction.transaction_type,
      transaction_code: financeTransaction.transaction_code,
    })
    .from(financeTransaction)
    .where(
      and(
        inArray(financeTransaction.account_id, accountIds),
        eq(financeTransaction.funds_code, "SECU"),
      ),
    );

  for (const tx of txs) {
    const kind = classifySecuTransaction(tx);
    if (kind === null) {
      stats.skipped++;
      continue;
    }

    const isin =
      extractIsin(tx.purpose) ?? extractIsin(tx.counterparty);
    if (!isin) {
      stats.skipped++;
      continue;
    }

    // Find a depot account on the same bankcontact whose holdings
    // include this ISIN. Pick the most recent snapshot to break ties.
    const [holding] = await db
      .select({
        account_id: financeAccountHolding.account_id,
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
          eq(financeAccountHolding.isin, isin),
        ),
      )
      .orderBy(desc(financeAccountHolding.as_of))
      .limit(1);

    if (!holding) {
      stats.skipped++;
      continue;
    }

    // Build the row. Net amount on the giro side is the cash flow with
    // its original sign; gross_amount is the absolute value (the giro
    // booking already nets fees, so we don't try to split them out).
    const netSigned = Number(tx.amount);
    const gross = Math.abs(netSigned).toFixed(2);
    const net = netSigned.toFixed(2);
    const dedupeHash = `giro:${tx.id}`;

    try {
      const inserted = await db
        .insert(financeDepotTransaction)
        .values({
          account_id: holding.account_id,
          isin,
          wkn: holding.wkn,
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
        `tx ${tx.id} (${isin}): derivation insert failed: ` +
          ((err as Error).message ?? String(err)),
      );
    }
  }

  return stats;
}
